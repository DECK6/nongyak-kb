import { XMLParser } from "fast-xml-parser";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ServiceCode = "SVC01" | "SVC02" | "SVC07" | "SVC08";

type ParsedEnvelope = {
  totalCount?: number;
  errorCode?: string;
  errorMsg?: string;
  items: Record<string, string>[];
};

type PagedState = {
  totalCount?: number;
  pageSize?: number;
  fetchedPages: number[];
  done: boolean;
  updatedAt: string;
};

type DetailState = {
  pending: string[];
  done: string[];
  updatedAt: string;
};

type Manifest = Record<string, unknown>;

type Download = {
  bytes: Uint8Array;
  envelope: ParsedEnvelope;
};

const PAGE_SIZE = 50;
const MAX_RETRIES = 5;
const REQUEST_INTERVAL_MS = 250;
const BACKOFF_BASE_MS = 500;
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(projectDir, "fixtures");
const defaultRawDir = join(projectDir, "data", "raw");

class RateLimiter {
  private nextRequestAt = 0;

  async wait(): Promise<void> {
    await sleep(Math.max(0, this.nextRequestAt - Date.now()));
    this.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return String(value);
}

export function parseEnvelope(xml: string): {
  totalCount?: number;
  errorCode?: string;
  errorMsg?: string;
  items: Record<string, string>[];
} {
  const parsed = asRecord(
    new XMLParser({
      parseTagValue: false,
      trimValues: true,
    }).parse(xml),
  );
  const service = asRecord(parsed?.service);

  if (!service) {
    throw new Error("Invalid PSIS XML envelope: missing <service> root");
  }

  const list = asRecord(service.list);
  const rawItems =
    list?.item === undefined
      ? []
      : Array.isArray(list.item)
        ? list.item
        : [list.item];
  const totalCountText = optionalString(service.totalCount);
  const totalCount =
    totalCountText === undefined || totalCountText === ""
      ? undefined
      : Number(totalCountText);

  return {
    ...(totalCount !== undefined &&
      Number.isSafeInteger(totalCount) &&
      totalCount >= 0
        ? { totalCount }
        : {}),
    ...(service.errorCode !== undefined
      ? { errorCode: optionalString(service.errorCode) }
      : {}),
    ...(service.errorMsg !== undefined
      ? { errorMsg: optionalString(service.errorMsg) }
      : {}),
    items: rawItems.flatMap((rawItem) => {
      const item = asRecord(rawItem);

      if (!item) {
        return [];
      }

      return [
        Object.fromEntries(
          Object.entries(item).map(([key, value]) => [
            key,
            value === undefined || value === null ? "" : String(value),
          ]),
        ),
      ];
    }),
  };
}

function pageFileName(page: number): string {
  return `page-${String(page).padStart(4, "0")}.xml`;
}

function uniqueSortedPages(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1,
      ),
    ),
  ].sort((left, right) => left - right);
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ];
}

function readPagedState(value: unknown, service: ServiceCode): PagedState {
  const record = asRecord(value);
  const totalCount =
    typeof record?.totalCount === "number" &&
    Number.isFinite(record.totalCount) &&
    record.totalCount >= 0
      ? record.totalCount
      : undefined;

  return {
    ...(totalCount === undefined ? {} : { totalCount }),
    ...(service === "SVC01" ? { pageSize: PAGE_SIZE } : {}),
    fetchedPages: uniqueSortedPages(record?.fetchedPages),
    done: record?.done === true,
    updatedAt:
      typeof record?.updatedAt === "string" ? record.updatedAt : "",
  };
}

function readDetailState(value: unknown): DetailState {
  const record = asRecord(value);

  return {
    pending: uniqueStrings(record?.pending),
    done: uniqueStrings(record?.done),
    updatedAt:
      typeof record?.updatedAt === "string" ? record.updatedAt : "",
  };
}

async function readManifest(rawDir: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(
      await readFile(join(rawDir, "manifest.json"), "utf8"),
    );

    return asRecord(parsed) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

// 외장 볼륨(/Volumes)에서 write가 간헐적으로 EINTR로 실패해 재시도가 필요하다
async function writeFileRetry(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeFile(path, data);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EINTR" && code !== "EAGAIN") || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function writeManifest(
  rawDir: string,
  manifest: Manifest,
): Promise<void> {
  await mkdir(rawDir, { recursive: true });
  await writeFileRetry(
    join(rawDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function retryOrThrow(
  attempt: number,
  error: Error,
): Promise<void> {
  if (attempt === MAX_RETRIES) {
    throw error;
  }

  await sleep(BACKOFF_BASE_MS * 2 ** attempt);
}

async function download(
  url: URL,
  limiter: RateLimiter,
  context: string,
): Promise<Download> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await limiter.wait();

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      await retryOrThrow(
        attempt,
        new Error(
          `${context}: network request failed after ${attempt + 1} attempt(s)`,
          { cause },
        ),
      );
      continue;
    }

    if (response.status >= 500 && response.status <= 599) {
      await retryOrThrow(
        attempt,
        new Error(
          `${context}: HTTP ${response.status} after ${attempt + 1} attempt(s)`,
        ),
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(`${context}: HTTP ${response.status}`);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      await retryOrThrow(
        attempt,
        new Error(
          `${context}: response read failed after ${attempt + 1} attempt(s)`,
          { cause },
        ),
      );
      continue;
    }

    const envelope = parseEnvelope(new TextDecoder().decode(bytes));

    if (
      envelope.errorCode === "ERR_101" ||
      envelope.errorCode === "ERR_102" ||
      envelope.errorCode === "ERR_103" ||
      envelope.errorCode === "ERR_104" ||
      envelope.errorCode === "ERR_201"
    ) {
      throw new Error(
        `${context}: ${envelope.errorCode}${
          envelope.errorMsg ? ` ${envelope.errorMsg}` : ""
        }`,
      );
    }

    if (envelope.errorCode === "ERR_901") {
      await retryOrThrow(
        attempt,
        new Error(
          `${context}: ERR_901${
            envelope.errorMsg ? ` ${envelope.errorMsg}` : ""
          } after ${attempt + 1} attempt(s)`,
        ),
      );
      continue;
    }

    if (envelope.errorCode) {
      throw new Error(
        `${context}: ${envelope.errorCode}${
          envelope.errorMsg ? ` ${envelope.errorMsg}` : ""
        }`,
      );
    }

    return { bytes, envelope };
  }

  throw new Error(`${context}: retry limit exhausted`);
}

function pagedUrl(
  service: "SVC01" | "SVC07" | "SVC08",
  page: number,
  apiKey: string,
): URL {
  const url = new URL(
    service === "SVC07"
      ? "https://psis.rda.go.kr/openApi/hmpgContService.do"
      : service === "SVC08"
        ? "https://psis.rda.go.kr/openApi/cnclAgchm.do"
        : "https://psis.rda.go.kr/openApi/service.do",
  );
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("serviceCode", service);
  url.searchParams.set("serviceType", service === "SVC07" ? "AA007" : "AA001");
  url.searchParams.set("displayCount", String(PAGE_SIZE));
  // PSIS의 startPoint는 페이지 번호가 아니라 1-기반 아이템 오프셋이다 (실측 확인)
  url.searchParams.set("startPoint", String((page - 1) * PAGE_SIZE + 1));
  return url;
}

function detailUrl(
  pestiCode: string,
  diseaseUseSeq: string,
  apiKey: string,
): URL {
  const url = new URL("https://psis.rda.go.kr/openApi/service.do");
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("serviceCode", "SVC02");
  url.searchParams.set("pestiCode", pestiCode);
  url.searchParams.set("diseaseUseSeq", diseaseUseSeq);
  return url;
}

function pagedDone(state: PagedState): boolean {
  if (state.totalCount === undefined) {
    return false;
  }

  const fetched = new Set(state.fetchedPages);
  return Array.from(
    { length: Math.ceil(state.totalCount / PAGE_SIZE) },
    (_, index) => index + 1,
  ).every((page) => fetched.has(page));
}

async function persistPagedState(
  rawDir: string,
  manifest: Manifest,
  service: "SVC01" | "SVC07" | "SVC08",
  state: PagedState,
): Promise<void> {
  state.fetchedPages = uniqueSortedPages(state.fetchedPages);
  state.done = pagedDone(state);
  state.updatedAt = new Date().toISOString();
  manifest[service] = state;
  await writeManifest(rawDir, manifest);
}

async function fetchPagedService(
  service: "SVC01" | "SVC07" | "SVC08",
  rawDir: string,
  manifest: Manifest,
  apiKey: string,
  limiter: RateLimiter,
): Promise<void> {
  const serviceDir = join(rawDir, service);
  const state = readPagedState(manifest[service], service);
  await mkdir(serviceDir, { recursive: true });

  if (
    state.totalCount === undefined &&
    state.fetchedPages.includes(1)
  ) {
    try {
      state.totalCount = parseEnvelope(
        await readFile(join(serviceDir, pageFileName(1)), "utf8"),
      ).totalCount;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      state.fetchedPages = state.fetchedPages.filter((page) => page !== 1);
    }
  }

  if (state.totalCount === undefined) {
    const result = await download(
      pagedUrl(service, 1, apiKey),
      limiter,
      `${service} page 1`,
    );

    if (result.envelope.totalCount === undefined) {
      throw new Error(`${service} page 1: response is missing totalCount`);
    }

    await writeFileRetry(join(serviceDir, pageFileName(1)), result.bytes);
    state.totalCount = result.envelope.totalCount;
    state.fetchedPages.push(1);
    await persistPagedState(rawDir, manifest, service, state);
  }

  for (
    let page = 1;
    page <= Math.ceil((state.totalCount ?? 0) / PAGE_SIZE);
    page += 1
  ) {
    if (state.fetchedPages.includes(page)) {
      continue;
    }

    const result = await download(
      pagedUrl(service, page, apiKey),
      limiter,
      `${service} page ${page}`,
    );

    if (result.envelope.totalCount === undefined) {
      throw new Error(`${service} page ${page}: response is missing totalCount`);
    }

    await writeFileRetry(join(serviceDir, pageFileName(page)), result.bytes);
    state.totalCount = result.envelope.totalCount;
    state.fetchedPages.push(page);
    await persistPagedState(rawDir, manifest, service, state);
  }

  await persistPagedState(rawDir, manifest, service, state);
}

async function collectProducts(
  rawDir: string,
  svc01: PagedState,
): Promise<Map<string, string>> {
  const products = new Map<string, string>();

  for (const page of svc01.fetchedPages) {
    const envelope = parseEnvelope(
      await readFile(join(rawDir, "SVC01", pageFileName(page)), "utf8"),
    );

    for (const item of envelope.items) {
      const pestiCode = item.pestiCode;
      const diseaseUseSeq = item.diseaseUseSeq;

      if (!pestiCode || !diseaseUseSeq) {
        throw new Error(
          `SVC01 page ${page}: item is missing pestiCode or diseaseUseSeq`,
        );
      }

      if (
        pestiCode === "." ||
        pestiCode === ".." ||
        pestiCode.includes("/") ||
        pestiCode.includes("\\")
      ) {
        throw new Error(`SVC01 page ${page}: unsafe pestiCode ${pestiCode}`);
      }

      if (!products.has(pestiCode)) {
        products.set(pestiCode, diseaseUseSeq);
      }
    }
  }

  return products;
}

async function fetchDetailService(
  rawDir: string,
  manifest: Manifest,
  apiKey: string,
  limiter: RateLimiter,
): Promise<void> {
  const svc01 = readPagedState(manifest.SVC01, "SVC01");

  if (!svc01.done) {
    throw new Error(
      "SVC02 requires a completed SVC01 collection in manifest.json",
    );
  }

  const serviceDir = join(rawDir, "SVC02");
  const products = await collectProducts(rawDir, svc01);
  const previous = readDetailState(manifest.SVC02);
  const done = new Set(previous.done);
  const state: DetailState = {
    pending: [...products.keys()].filter((pestiCode) => !done.has(pestiCode)),
    done: [...done],
    updatedAt: new Date().toISOString(),
  };
  await mkdir(serviceDir, { recursive: true });
  manifest.SVC02 = state;
  await writeManifest(rawDir, manifest);

  while (state.pending.length > 0) {
    const pestiCode = state.pending[0];
    const result = await download(
      detailUrl(pestiCode, products.get(pestiCode)!, apiKey),
      limiter,
      `SVC02 pestiCode ${pestiCode}`,
    );
    await writeFileRetry(join(serviceDir, `${pestiCode}.xml`), result.bytes);
    state.pending.shift();
    done.add(pestiCode);
    state.done = [...done];
    state.updatedAt = new Date().toISOString();
    await writeManifest(rawDir, manifest);
  }
}

async function fixturePageNumbers(service: "SVC01" | "SVC07" | "SVC08") {
  const entries = await readdir(join(fixturesDir, service), {
    withFileTypes: true,
  });

  return entries
    .flatMap((entry) => {
      const match = entry.isFile()
        ? entry.name.match(/^page-(\d+)\.xml$/)
        : null;
      return match ? [Number(match[1])] : [];
    })
    .sort((left, right) => left - right);
}

async function fixtureTotalCount(
  service: "SVC01" | "SVC07" | "SVC08",
  pages: number[],
): Promise<number> {
  if (pages.length === 0) {
    return 0;
  }

  return (
    parseEnvelope(
      await readFile(
        join(fixturesDir, service, pageFileName(pages[0])),
        "utf8",
      ),
    ).totalCount ?? 0
  );
}

async function fetchMock(rawDir: string): Promise<void> {
  await mkdir(rawDir, { recursive: true });
  await cp(fixturesDir, rawDir, { recursive: true, force: true });

  const svc01Pages = await fixturePageNumbers("SVC01");
  const svc07Pages = await fixturePageNumbers("SVC07");
  const svc08Pages = await fixturePageNumbers("SVC08");
  const detailFiles = (
    await readdir(join(fixturesDir, "SVC02"), { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".xml"))
    .map((entry) => entry.name.slice(0, -4))
    .sort();
  const updatedAt = new Date().toISOString();
  const manifest: Manifest = {
    SVC01: {
      totalCount: await fixtureTotalCount("SVC01", svc01Pages),
      pageSize: PAGE_SIZE,
      fetchedPages: svc01Pages,
      done: true,
      updatedAt,
    },
    SVC02: {
      pending: [],
      done: detailFiles,
      updatedAt,
    },
    SVC07: {
      totalCount: await fixtureTotalCount("SVC07", svc07Pages),
      fetchedPages: svc07Pages,
      done: true,
      updatedAt,
    },
    SVC08: {
      totalCount: await fixtureTotalCount("SVC08", svc08Pages),
      fetchedPages: svc08Pages,
      done: true,
      updatedAt,
    },
  };
  await writeManifest(rawDir, manifest);
}

export async function fetchAll(opts: {
  services?: ServiceCode[];
  mock?: boolean;
  rawDir?: string;
}): Promise<void> {
  const rawDir = opts.rawDir ?? defaultRawDir;

  if (opts.mock) {
    await fetchMock(rawDir);
    return;
  }

  const selected = new Set<ServiceCode>(
    opts.services ?? ["SVC01", "SVC02", "SVC07", "SVC08"],
  );

  if (selected.size === 0) {
    return;
  }

  const apiKey = process.env.PSIS_API_KEY;

  if (!apiKey) {
    throw new Error(
      "PSIS_API_KEY is required for network fetches; set it or use --mock",
    );
  }

  const manifest = await readManifest(rawDir);
  const limiter = new RateLimiter();

  if (selected.has("SVC01")) {
    await fetchPagedService("SVC01", rawDir, manifest, apiKey, limiter);
  }
  if (selected.has("SVC02")) {
    await fetchDetailService(rawDir, manifest, apiKey, limiter);
  }
  if (selected.has("SVC07")) {
    await fetchPagedService("SVC07", rawDir, manifest, apiKey, limiter);
  }
  if (selected.has("SVC08")) {
    await fetchPagedService("SVC08", rawDir, manifest, apiKey, limiter);
  }
}

function parseCliArgs(args: string[]): {
  services?: ServiceCode[];
  mock?: boolean;
} {
  const services: ServiceCode[] = [];
  let mock = false;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--mock") {
      mock = true;
      continue;
    }

    if (args[index] === "--service") {
      const service = args[index + 1];

      if (
        service !== "SVC01" &&
        service !== "SVC02" &&
        service !== "SVC07" &&
        service !== "SVC08"
      ) {
        throw new Error(
          "--service requires one of SVC01, SVC02, SVC07, or SVC08",
        );
      }

      services.push(service);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${args[index]}`);
  }

  return {
    ...(services.length > 0 ? { services } : {}),
    ...(mock ? { mock: true } : {}),
  };
}

if (import.meta.main) {
  try {
    await fetchAll(parseCliArgs(Bun.argv.slice(2)));
  } catch (error) {
    console.error(
      `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
