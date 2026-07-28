import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { matchesRevoked, type RevokedRecord } from "./revoked";

type UsageRow = {
  pesti_code: string;
  disease_use_seq: string;
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
  use_name: string | null;
  eng_name: string | null;
  ingredient_name: string | null;
  indict_symbl: string | null;
  toxic_name: string | null;
  fish_toxic_gubun: string | null;
  reg_cpnt_qnty: string | null;
  crop_name: string | null;
  crop_lrcl_nm: string | null;
  pest_name: string | null;
  pesti_use: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
};

type ProductRow = {
  pesti_code: string;
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
  eng_name: string | null;
  ingredient_name: string | null;
  cmpa_itm_nm: string | null;
  indict_symbl: string | null;
  use_name: string | null;
  apply_first_reg_date: string | null;
  reg_cpnt_qnty: string | null;
  toxic_gubun: string | null;
  toxic_name: string | null;
  fish_toxic_gubun: string | null;
};

type RevokedRow = {
  prdlst_regist_no: string;
  pesti_kor_name: string | null;
  brand_name: string | null;
  comp_name: string | null;
  eng_name: string | null;
  cmpa_itm_nm: string | null;
  regist_stndrd: string | null;
  revoked_date: string | null;
};

type ProductUsageRow = {
  disease_use_seq: string;
  crop_name: string | null;
  pest_name: string | null;
  pesti_use: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
  wafindex: string | null;
};

type ProductView = {
  code: string;
  name: string;
  brand: string | null;
  company: string | null;
  engName: string | null;
  ingredientName: string | null;
  manufactureType: string | null;
  modeOfAction: string | null;
  useName: string | null;
  registeredDate: string | null;
  ingredientQuantity: string | null;
  toxicityCode: string | null;
  toxicityName: string | null;
  fishToxicity: string | null;
  revoked: boolean;
  revokedDate: string | null;
  usageRules: ProductUsageRow[];
};

type ParsedCommand =
  | { command: "query"; search: string; json: boolean; limit: number }
  | { command: "product"; search: string }
  | { command: "rotate"; search: string; used: string[]; json: boolean }
  | { command: "stats" };

function parseCommand(argv: string[]): ParsedCommand | null {
  const [command, ...args] = argv;
  if (command === "query") {
    let search = "";
    let json = false;
    let limit = 20;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--json") {
        json = true;
        continue;
      }
      if (arg === "--limit") {
        const value = args[index + 1];
        if (!value || !/^\d+$/.test(value)) return null;
        limit = Number(value);
        if (!Number.isSafeInteger(limit)) return null;
        index += 1;
        continue;
      }
      if (arg.startsWith("--") || search) return null;
      search = arg.trim();
    }
    if (!search) return null;
    return { command, search, json, limit };
  }
  if (command === "product") {
    if (args.length !== 1 || !args[0]!.trim()) return null;
    return { command, search: args[0]!.trim() };
  }
  if (command === "rotate") {
    let search = "";
    let json = false;
    const used: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "--json") {
        json = true;
        continue;
      }
      if (arg === "--used") {
        const value = args[index + 1];
        if (!value || value.startsWith("--") || !value.trim()) return null;
        used.push(value.trim());
        index += 1;
        continue;
      }
      if (arg.startsWith("--") || search) return null;
      search = arg.trim();
    }
    if (!search || used.length === 0) return null;
    return { command, search, used, json };
  }
  if (command === "stats" && args.length === 0) return { command };
  return null;
}

// 작용기작 코드를 계열 집합으로 분해한다. 복합제 "아5+다3" → {아5, 다3}.
// 전착제 등 방제와 무관한 비대상 성분은 로테이션 판정에서 제외한다.
function parseModeOfAction(symbl: string | null): Set<string> {
  const groups = (symbl ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part && part !== "-" && !part.startsWith("비대상"));
  return new Set(groups);
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return false;
  return true;
}

function tsvCell(value: string | null): string {
  return (value ?? "").replace(/[\t\r\n]+/g, " ");
}

// 웹앱과 같은 컬럼·같은 부분일치로 검색한다. FTS5(unicode61)는 토큰 접두만 잡아
// "conazole"이나 "단고추류" 같은 토큰 중간·끝 입력을 놓치는데, 계열 접미사 검색은
// 농약 선택에서 흔한 사용법이라 웹과 결과가 갈리면 안 된다.
const SEARCH_COLUMNS = [
  "crop_name",
  "pest_name",
  "pesti_kor_name",
  "brand_name",
  "comp_name",
  "eng_name",
  "ingredient_name",
] as const;

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, "!$&");
}

// 공백 구분 토큰을 AND 결합 — "고추 탄저병"처럼 작물·병해충이 다른 컬럼에 있어도 매치된다
function buildSearchFilter(
  search: string,
): { sql: string; parameters: string[] } | null {
  const tokens = search.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const clauses: string[] = [];
  const parameters: string[] = [];
  for (const token of tokens) {
    clauses.push(
      `(${SEARCH_COLUMNS.map(
        (column) => `COALESCE(v.${column}, '') LIKE ? ESCAPE '!'`,
      ).join(" OR ")})`,
    );
    const pattern = `%${escapeLike(token)}%`;
    parameters.push(...SEARCH_COLUMNS.map(() => pattern));
  }
  return { sql: clauses.join(" AND "), parameters };
}

// v_usage에는 등록상태가 없다 — 등록취소 목록은 별도 테이블이므로 소비 시점에 대조한다
function loadRevokedRecords(db: Database): RevokedRecord[] {
  return db
    .query("SELECT pesti_kor_name, brand_name, comp_name FROM revoked_products")
    .all() as RevokedRecord[];
}

function queryCommand(db: Database, search: string, json: boolean, limit: number): void {
  const filter = buildSearchFilter(search);
  if (filter === null) {
    if (json) console.log("[]");
    return;
  }
  const rows = db
    .query(`
      SELECT v.*
      FROM v_usage v
      WHERE ${filter.sql}
      ORDER BY
        v.pesti_kor_name, v.brand_name, v.crop_name, v.pest_name,
        v.pesti_code, v.disease_use_seq
      LIMIT ?
    `)
    // 한 건 더 읽어 결과가 잘렸는지 알아낸다 — 잘린 줄 모르면 후보 약제를 놓친다
    .all(...filter.parameters, limit + 1) as UsageRow[];
  const truncated = rows.length > limit;
  if (truncated) {
    rows.length = limit;
  }
  if (rows.length === 0) {
    if (json) console.log("[]");
    return;
  }

  if (truncated) {
    console.error(`결과가 --limit ${limit}에서 잘렸습니다 — 더 보려면 --limit을 늘리세요`);
  }

  // 검색 결과에는 등록취소된 제품도 섞여 나온다. 소비자가 구분할 수 있어야 한다.
  const revokedRecords = loadRevokedRecords(db);
  const marked = rows.map((row) => ({
    ...row,
    revoked: revokedRecords.some((record) => matchesRevoked(row, record)),
  }));

  if (json) {
    console.log(JSON.stringify(marked));
    return;
  }

  const lines = [
    "품목명\t상표명\t회사\t작물\t병해충\t희석배수\t사용적기\t안전사용기준\t등록상태",
    ...marked.map((row) =>
      [
        row.pesti_kor_name,
        row.brand_name,
        row.comp_name,
        row.crop_name,
        row.pest_name,
        row.dilut_unit,
        row.pesti_use,
        [row.use_suittime, row.use_num].filter(Boolean).join(" / "),
        row.revoked ? "등록취소" : "등록",
      ]
        .map(tsvCell)
        .join("\t"),
    ),
  ];
  console.log(lines.join("\n"));
}

function productCommand(db: Database, search: string): void {
  const products = db
    .query(`
      SELECT *
      FROM products
      WHERE
        pesti_kor_name = ?1 OR brand_name = ?1 OR
        instr(pesti_kor_name, ?1) > 0 OR instr(COALESCE(brand_name, ''), ?1) > 0
      ORDER BY
        CASE WHEN pesti_kor_name = ?1 OR brand_name = ?1 THEN 0 ELSE 1 END,
        pesti_kor_name, brand_name, pesti_code
    `)
    .all(search) as ProductRow[];
  const revokedProducts = db
    .query(`
      SELECT
        prdlst_regist_no, pesti_kor_name, brand_name, comp_name,
        eng_name, cmpa_itm_nm, regist_stndrd, revoked_date
      FROM revoked_products
      ORDER BY pesti_kor_name, brand_name, prdlst_regist_no
    `)
    .all() as RevokedRow[];
  const usageStatement = db.query(`
    SELECT
      u.disease_use_seq, c.crop_name, pe.name AS pest_name, u.pesti_use,
      u.dilut_unit, u.use_suittime, u.use_num, u.wafindex
    FROM usage_rules u
    LEFT JOIN crops c ON c.crop_cd = u.crop_cd
    LEFT JOIN pests pe ON pe.pest_id = u.pest_id
    WHERE u.pesti_code = ?
    ORDER BY u.disease_use_seq
  `);
  const consumedRevoked = new Set<string>();
  const views: ProductView[] = products.map((product) => {
    const matches = revokedProducts.filter((revoked) => matchesRevoked(product, revoked));
    for (const revoked of matches) consumedRevoked.add(revoked.prdlst_regist_no);
    return {
      code: product.pesti_code,
      name: product.pesti_kor_name,
      brand: product.brand_name,
      company: product.comp_name,
      engName: product.eng_name,
      ingredientName: product.ingredient_name,
      manufactureType: product.cmpa_itm_nm,
      modeOfAction: product.indict_symbl,
      useName: product.use_name,
      registeredDate: product.apply_first_reg_date,
      ingredientQuantity: product.reg_cpnt_qnty,
      toxicityCode: product.toxic_gubun,
      toxicityName: product.toxic_name,
      fishToxicity: product.fish_toxic_gubun,
      revoked: matches.length > 0,
      revokedDate: matches.find((match) => match.revoked_date)?.revoked_date ?? null,
      usageRules: usageStatement.all(product.pesti_code) as ProductUsageRow[],
    };
  });

  for (const revoked of revokedProducts) {
    if (
      consumedRevoked.has(revoked.prdlst_regist_no) ||
      !(
        revoked.pesti_kor_name?.includes(search) ||
        revoked.brand_name?.includes(search)
      )
    ) {
      continue;
    }
    views.push({
      code: revoked.prdlst_regist_no,
      name: revoked.pesti_kor_name ?? revoked.prdlst_regist_no,
      brand: revoked.brand_name,
      company: revoked.comp_name,
      engName: revoked.eng_name,
      ingredientName: null,
      manufactureType: revoked.cmpa_itm_nm,
      modeOfAction: null,
      useName: null,
      registeredDate: null,
      ingredientQuantity: revoked.regist_stndrd,
      toxicityCode: null,
      toxicityName: null,
      fishToxicity: null,
      revoked: true,
      revokedDate: revoked.revoked_date,
      usageRules: [],
    });
  }

  if (views.length === 0) return;
  views.sort((left, right) => {
    const leftExact = left.name === search || left.brand === search;
    const rightExact = right.name === search || right.brand === search;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    return left.name.localeCompare(right.name, "ko-KR") || left.code.localeCompare(right.code);
  });
  console.log(
    views
      .map((product) => {
        const lines = [
          `품목코드: ${product.code}`,
          `품목명: ${product.name}`,
          `상표명: ${product.brand ?? ""}`,
          `회사: ${product.company ?? ""}`,
          `영문명: ${product.engName ?? ""}`,
          `주성분: ${product.ingredientName ?? ""}`,
          `제조/수입: ${product.manufactureType ?? ""}`,
          `작용기작: ${product.modeOfAction ?? ""}`,
          `용도: ${product.useName ?? ""}`,
          `최초등록일: ${product.registeredDate ?? ""}`,
          `주성분 함량: ${product.ingredientQuantity ?? ""}`,
          `독성 구분: ${product.toxicityCode ?? ""}`,
          `독성명: ${product.toxicityName ?? ""}`,
          `어독성: ${product.fishToxicity ?? ""}`,
          `등록상태: ${product.revoked ? "등록취소" : "등록"}`,
        ];
        if (product.revokedDate) lines.push(`등록취소일: ${product.revokedDate}`);
        if (product.usageRules.length === 0) {
          lines.push("사용기준: 없음");
          return lines.join("\n");
        }
        lines.push("사용기준:");
        for (const usage of product.usageRules) {
          lines.push(
            [
              `- 순번=${usage.disease_use_seq}`,
              `작물=${usage.crop_name ?? ""}`,
              `병해충=${usage.pest_name ?? ""}`,
              `사용적기=${usage.pesti_use ?? ""}`,
              `희석배수=${usage.dilut_unit ?? ""}`,
              `안전사용시기=${usage.use_suittime ?? ""}`,
              `사용횟수=${usage.use_num ?? ""}`,
              `WAF=${usage.wafindex ?? ""}`,
            ].join(" | "),
          );
        }
        return lines.join("\n");
      })
      .join("\n\n"),
  );
}

type RotateCandidate = {
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
  indict_symbl: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
};

function rotateCommand(
  db: Database,
  search: string,
  used: string[],
  json: boolean,
): void {
  const filter = buildSearchFilter(search);
  if (filter === null) {
    console.error("작물·병해충 검색어가 필요합니다");
    return;
  }
  // 작물×병해충으로 스코프한 약제. v_usage에는 등록취소 제품도 들어 있으므로
  // 처방으로 내보내기 전에 등록취소 목록과 대조해 걸러낸다.
  const allRows = db
    .query(`
      SELECT DISTINCT
        v.pesti_kor_name, v.brand_name, v.comp_name, v.indict_symbl,
        v.dilut_unit, v.use_suittime, v.use_num
      FROM v_usage v
      WHERE ${filter.sql}
      ORDER BY v.pesti_kor_name, v.brand_name
    `)
    .all(...filter.parameters) as RotateCandidate[];
  const revokedRecords = loadRevokedRecords(db);
  const rows = allRows.filter(
    (row) => !revokedRecords.some((record) => matchesRevoked(row, record)),
  );
  const excludedRevoked = allRows.length - rows.length;
  if (rows.length === 0) {
    if (json) {
      console.log(
        JSON.stringify({
          scope: search,
          usedGroups: [],
          unresolved: [],
          ambiguousUsed: [],
          recommended: [],
          avoid: [],
          excludedRevoked,
        }),
      );
    } else {
      console.error(`해당 작물·병해충에 등록된 약제가 없습니다: ${search}`);
    }
    return;
  }

  // 올해 쓴 약제(들)의 작용기작 계열을 스코프 내에서 해석.
  // --used 값은 약제명(상표/품목 부분일치) 또는 작용기작 코드 자체를 허용.
  // 성분명(예: 만코제브)은 이를 포함한 복합제까지 매치되므로, 매치된 약제 중
  // 계열 수가 가장 적은 제형으로 해석해 회피 계열의 과잉 확장을 막는다.
  const usedGroups = new Set<string>();
  const unresolved: string[] = [];
  const ambiguousUsed: string[] = [];
  for (const term of used) {
    const matched = rows.filter((row) =>
      `${row.pesti_kor_name} ${row.brand_name ?? ""}`.includes(term),
    );
    if (matched.length > 0) {
      let narrowest: Set<string> | undefined;
      const variants = new Set<string>();
      for (const row of matched) {
        const groups = parseModeOfAction(row.indict_symbl);
        if (groups.size === 0) continue;
        variants.add([...groups].sort().join("+"));
        if (!narrowest || groups.size < narrowest.size) {
          narrowest = groups;
        }
      }
      if (narrowest) {
        // 좁은 쪽으로 해석하면 회피 범위가 줄어든다 — 갈렸다는 사실을 반드시 알린다
        if (variants.size > 1) {
          ambiguousUsed.push(
            `${term}: ${[...variants].join(" / ")} 중 ${[...narrowest].join(",")}로 해석`,
          );
        }
        for (const group of narrowest) usedGroups.add(group);
        continue;
      }
    }
    // 약제명으로 못 찾으면 작용기작 코드로 간주
    if (rows.some((row) => parseModeOfAction(row.indict_symbl).has(term))) {
      usedGroups.add(term);
      continue;
    }
    unresolved.push(term);
  }
  if (usedGroups.size === 0) {
    console.error(
      `사용 약제의 작용기작을 확인할 수 없습니다 (미해석: ${unresolved.join(", ")}). ` +
        `해당 작물·병해충에 등록된 약제명 또는 작용기작 코드로 지정하세요.`,
    );
    return;
  }

  if (ambiguousUsed.length > 0) {
    for (const note of ambiguousUsed) console.error(`사용 약제 해석 주의 — ${note}`);
  }

  const recommended: RotateCandidate[] = [];
  const avoid: RotateCandidate[] = [];
  for (const row of rows) {
    const groups = parseModeOfAction(row.indict_symbl);
    if (groups.size > 0 && disjoint(groups, usedGroups)) recommended.push(row);
    else avoid.push(row);
  }

  if (json) {
    console.log(
      JSON.stringify({
        scope: search,
        usedGroups: [...usedGroups],
        unresolved,
        ambiguousUsed,
        recommended,
        avoid,
        excludedRevoked,
      }),
    );
    return;
  }

  const line = (row: RotateCandidate): string =>
    [
      row.indict_symbl,
      row.pesti_kor_name,
      row.brand_name,
      row.comp_name,
      row.dilut_unit,
      [row.use_suittime, row.use_num].filter(Boolean).join(" / "),
    ]
      .map(tsvCell)
      .join("\t");

  const out: string[] = [];
  out.push(`# ${search} — 올해 사용 작용기작: ${[...usedGroups].join(", ")}`);
  if (unresolved.length > 0) out.push(`# 미해석 입력(무시됨): ${unresolved.join(", ")}`);
  for (const note of ambiguousUsed) out.push(`# 해석 주의 — ${note}`);
  if (excludedRevoked > 0) out.push(`# 등록취소 제외: ${excludedRevoked}종`);
  out.push("");
  out.push(`## 권장 — 다른 작용기작 계열 (${recommended.length}종)`);
  out.push("작용기작\t품목명\t상표명\t회사\t희석배수\t안전사용기준");
  out.push(...recommended.map(line));
  out.push("");
  out.push(`## 회피 — 같은 계열 포함 (${avoid.length}종)`);
  out.push("작용기작\t품목명\t상표명\t회사\t희석배수\t안전사용기준");
  out.push(...avoid.map(line));
  console.log(out.join("\n"));
}

function statsCommand(db: Database, dbPath: string): void {
  const tableNames = [
    "products",
    "crops",
    "pests",
    "usage_rules",
    "revoked_products",
    "analysis_methods",
    "v_usage",
    "fts_usage",
  ] as const;
  const lines = ["테이블\t건수"];
  for (const tableName of tableNames) {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    lines.push(`${tableName}\t${row.count}`);
  }
  lines.push(`kb.sqlite mtime\t${statSync(dbPath).mtime.toISOString()}`);
  console.log(lines.join("\n"));
}

export async function runCli(argv: string[], dbPath?: string): Promise<number> {
  const parsed = parseCommand(argv);
  if (!parsed) {
    console.error(
      "사용법: kb query <검색어> [--json] [--limit N] | kb product <이름> | " +
        "kb rotate <작물 병해충> --used <약제명|작용기작> [--used ...] [--json] | kb stats",
    );
    return 1;
  }

  const resolvedDbPath = resolve(dbPath ?? "data/kb.sqlite");
  if (!existsSync(resolvedDbPath)) {
    console.error(`DB 파일이 없습니다: ${resolvedDbPath}`);
    return 1;
  }

  let db: Database | undefined;
  try {
    db = new Database(resolvedDbPath, { readonly: true, strict: true });
    if (parsed.command === "query") {
      queryCommand(db, parsed.search, parsed.json, parsed.limit);
    } else if (parsed.command === "product") {
      productCommand(db, parsed.search);
    } else if (parsed.command === "rotate") {
      rotateCommand(db, parsed.search, parsed.used, parsed.json);
    } else {
      statsCommand(db, resolvedDbPath);
    }
    return 0;
  } catch (error) {
    console.error(`오류: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
