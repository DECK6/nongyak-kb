import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../src/cli";
import { exportGraph } from "../src/export-graph";

const projectRoot = resolve(import.meta.dir, "..");
const tempDir = mkdtempSync(join(tmpdir(), "nongyak-kb-cli-"));
const dbPath = join(tempDir, "kb.sqlite");

async function invokeCli(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(" "));
  });

  try {
    return { code: await runCli(argv, dbPath), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

beforeAll(() => {
  const db = new Database(dbPath);
  db.exec(readFileSync(join(projectRoot, "contracts/schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, cmpa_itm_nm, indict_symbl, use_name,
      apply_first_reg_date, reg_cpnt_qnty, toxic_gubun, toxic_name,
      fish_toxic_gubun
    ) VALUES (
      '2088', '만코제브 수화제', '다이센엠-45', '(주)경농', 'mancozeb WP75 %',
      'mancozeb', '제조', '카', '살균제',
      '19680301', '75', 'Ⅳ', '저독성', 'Ⅲ급'
    );
    INSERT INTO crops (crop_cd, crop_name, crop_lrcl_cd, crop_lrcl_nm)
    VALUES ('4100', '사과', '10', '과수류');
    INSERT INTO pests (pest_id, name) VALUES (1, '탄저병');
    INSERT INTO usage_rules (
      pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
      dilut_unit, use_suittime, use_num, wafindex
    ) VALUES (
      '2088', '4', '4100', 1, '발병초부터 10일 간격 경엽처리',
      '500배 -', '수확 30일 전까지', '4회 이내', '1'
    );
    INSERT INTO revoked_products (
      prdlst_regist_no, cmpa_itm_nm, pesti_kor_name, eng_name,
      regist_stndrd, brand_name, comp_name, revoked_date
    ) VALUES (
      '1001-살균-6', '수입', '엑스12485473 액상제', 'X12485473',
      '5%', '용수표', '(주)농촌진흥청', '2021-09-14'
    );
    INSERT INTO fts_usage (
      pesti_code, disease_use_seq, crop_name, pest_name, pesti_kor_name,
      brand_name, comp_name, eng_name, use_name
    ) VALUES (
      '2088', '4', '사과', '탄저병', '만코제브 수화제',
      '다이센엠-45', '(주)경농', 'mancozeb WP75 %', '살균제'
    );
    INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, cmpa_itm_nm, indict_symbl, use_name,
      apply_first_reg_date, reg_cpnt_qnty, toxic_gubun, toxic_name, fish_toxic_gubun
    ) VALUES (
      '3100', '디페노코나졸 액상수화제', '푸름이', '(주)팜한농', 'difenoconazole SC10 %',
      'difenoconazole', '제조', '사1', '살균제', '20100101', '10', 'Ⅳ', '저독성', 'Ⅲ급'
    );
    INSERT INTO usage_rules (
      pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
      dilut_unit, use_suittime, use_num, wafindex
    ) VALUES (
      '3100', '1', '4100', 1, '발병초 경엽처리', '2000배 -', '수확 7일 전까지', '2회 이내', '1'
    );
    INSERT INTO fts_usage (
      pesti_code, disease_use_seq, crop_name, pest_name, pesti_kor_name,
      brand_name, comp_name, eng_name, use_name
    ) VALUES (
      '3100', '1', '사과', '탄저병', '디페노코나졸 액상수화제',
      '푸름이', '(주)팜한농', 'difenoconazole SC10 %', '살균제'
    );
    -- 같은 회사가 같은 상표로 제형만 바꿔 재등록한 이력: 현행 3100은 등록 상태다
    INSERT INTO revoked_products (
      prdlst_regist_no, cmpa_itm_nm, pesti_kor_name, eng_name,
      regist_stndrd, brand_name, comp_name, revoked_date
    ) VALUES (
      '2001-살균-3', '제조', '디페노코나졸 수화제', 'difenoconazole',
      '10%', '푸름이', '(주)팜한농', '2022-03-26'
    );
    -- 품목명·상표명·회사가 모두 일치하는 실제 등록취소 제품
    INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, cmpa_itm_nm, indict_symbl, use_name,
      apply_first_reg_date, reg_cpnt_qnty, toxic_gubun, toxic_name, fish_toxic_gubun
    ) VALUES (
      '4200', '카보퓨란 입제', '후라단', '(주)농사랑', 'carbofuran GR3 %',
      'carbofuran', '제조', '나', '살충제', '19900101', '3', 'Ⅱ', '보통독성', 'Ⅱ급'
    );
    INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, use_name
    ) VALUES (
      '5000', '아족시스트로빈·프로피코나졸 유현탁제', '복합킹', '(주)농약',
      'Azoxystrobin.Propiconazole SE 18.71(7.01+11.7) %',
      'Azoxystrobin.Propiconazole', '살균제'
    );
    INSERT INTO revoked_products (
      prdlst_regist_no, cmpa_itm_nm, pesti_kor_name, eng_name,
      regist_stndrd, brand_name, comp_name, revoked_date
    ) VALUES (
      '3001-살충-7', '제조', '카보퓨란 입제', 'carbofuran',
      '3%', '후라단', '(주)농사랑', '2023-01-31'
    );
    INSERT INTO usage_rules (
      pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
      dilut_unit, use_suittime, use_num, wafindex
    ) VALUES (
      '4200', '1', '4100', 1, '발병초 토양처리', '3kg/10a', '수확 60일 전까지', '1회 이내', '1'
    );
    INSERT INTO fts_usage (
      pesti_code, disease_use_seq, crop_name, pest_name, pesti_kor_name,
      brand_name, comp_name, eng_name, use_name
    ) VALUES (
      '4200', '1', '사과', '탄저병', '카보퓨란 입제',
      '후라단', '(주)농사랑', 'carbofuran GR3 %', '살충제'
    );
  `);
  db.close();
});

describe("runCli", () => {
  test("query returns at least one TSV result for 탄저병", async () => {
    const result = await invokeCli(["query", "탄저병"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")[0]).toBe(
      "품목명\t상표명\t회사\t작물\t병해충\t희석배수\t사용적기\t안전사용기준\t등록상태",
    );
    expect(result.stdout.split("\n").length).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain("만코제브 수화제");
  });

  test("query --json emits a parseable v_usage row array", async () => {
    const result = await invokeCli(["query", "탄저병", "--json"]);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;

    expect(result.code).toBe(0);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.pest_name === "탄저병")).toBe(true);
    expect(rows.map((row) => row.pesti_code)).toContain("2088");
  });

  test("query warns when results are cut off by the limit", async () => {
    const truncated = await invokeCli(["query", "탄저병", "--limit", "1"]);
    const complete = await invokeCli(["query", "탄저병", "--limit", "50"]);

    expect(truncated.stdout.split("\n").length).toBe(2);
    expect(truncated.stderr).toContain("--limit");
    expect(complete.stderr).toBe("");
  });

  test("query treats operators as phrase text and returns [] for no JSON results", async () => {
    const result = await invokeCli(["query", "탄저병 OR 사과", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  test("rotate recommends a different mode-of-action group than the one used", async () => {
    const result = await invokeCli(["rotate", "사과 탄저병", "--used", "만코제브", "--json"]);
    const data = JSON.parse(result.stdout) as {
      usedGroups: string[];
      recommended: Array<{ indict_symbl: string }>;
      avoid: Array<{ indict_symbl: string }>;
    };

    expect(result.code).toBe(0);
    // 성분명 만코제브는 계열 '카' 하나로만 해석되어야 한다 (복합제로 과잉 확장 금지)
    expect(data.usedGroups).toEqual(["카"]);
    expect(data.recommended.map((r) => r.indict_symbl)).toContain("사1");
    expect(data.recommended.every((r) => r.indict_symbl !== "카")).toBe(true);
    expect(data.avoid.map((r) => r.indict_symbl)).toContain("카");
  });

  test("rotate never recommends a product this CLI reports as revoked", async () => {
    const result = await invokeCli(["rotate", "사과 탄저병", "--used", "만코제브", "--json"]);
    const data = JSON.parse(result.stdout) as {
      recommended: Array<{ brand_name: string }>;
      avoid: Array<{ brand_name: string }>;
      excludedRevoked: number;
    };

    expect(result.code).toBe(0);
    // 후라단은 등록취소 제품이므로 어느 목록에도 처방으로 등장해서는 안 된다
    expect(data.recommended.map((row) => row.brand_name)).not.toContain("후라단");
    expect(data.avoid.map((row) => row.brand_name)).not.toContain("후라단");
    expect(data.excludedRevoked).toBe(1);
  });

  test("query marks whether each row's product is revoked", async () => {
    const result = await invokeCli(["query", "탄저병", "--json"]);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;

    expect(result.code).toBe(0);
    expect(rows.every((row) => typeof row.revoked === "boolean")).toBe(true);
    expect(rows.some((row) => row.revoked === true)).toBe(true);
    expect(rows.some((row) => row.revoked === false)).toBe(true);
  });

  test("rotate warns when a used agent resolves to more than one group set", async () => {
    // '카브리오'류처럼 상표 접두가 여러 제형에 걸치면 계열 해석이 갈린다.
    // 좁은 쪽으로 고르되 사용자가 그 사실을 알아야 저항성 관리가 어긋나지 않는다
    const result = await invokeCli(["rotate", "사과 탄저병", "--used", "제", "--json"]);
    const data = JSON.parse(result.stdout) as { ambiguousUsed: string[] };

    expect(result.code).toBe(0);
    expect(data.ambiguousUsed.length).toBeGreaterThanOrEqual(1);
    expect(result.stderr).toContain("해석");
  });

  test("rotate errors when the used agent cannot be resolved", async () => {
    const result = await invokeCli(["rotate", "사과 탄저병", "--used", "존재하지않는약"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("작용기작을 확인할 수 없습니다");
  });

  test("query matches partial tokens anywhere in the value", async () => {
    const prefix = await invokeCli(["query", "만코", "--json"]);
    // 웹앱과 같은 부분일치여야 한다 — 'difenoconazole'의 'conazole'처럼
    // 토큰 중간이나 끝만 입력해도 잡혀야 계열 검색이 성립한다
    const infix = await invokeCli(["query", "conazole", "--json"]);
    const suffix = await invokeCli(["query", "센엠", "--json"]);

    expect(JSON.parse(prefix.stdout)[0]?.pesti_kor_name).toBe("만코제브 수화제");
    expect(JSON.parse(infix.stdout)[0]?.pesti_kor_name).toBe("디페노코나졸 액상수화제");
    expect(JSON.parse(suffix.stdout)[0]?.brand_name).toBe("다이센엠-45");
  });

  test("query orders results deterministically before applying the limit", async () => {
    const first = await invokeCli(["query", "탄저병", "--json", "--limit", "1"]);
    const second = await invokeCli(["query", "탄저병", "--json", "--limit", "1"]);
    const rows = JSON.parse(first.stdout) as Array<Record<string, unknown>>;

    expect(first.stdout).toBe(second.stdout);
    // 품목명 오름차순이므로 '디페노코나졸'이 '만코제브'보다 먼저 온다
    expect(rows[0]?.pesti_kor_name).toBe("디페노코나졸 액상수화제");
  });

  test("product keeps a re-registered product marked as registered", async () => {
    const result = await invokeCli(["product", "푸름이"]);
    const blocks = result.stdout.split("\n\n");
    const current = blocks.find((block) =>
      block.includes("품목명: 디페노코나졸 액상수화제"),
    );
    const retired = blocks.find((block) =>
      block.includes("품목명: 디페노코나졸 수화제"),
    );

    expect(result.code).toBe(0);
    // 현행 등록 제품은 등록 상태를 유지하고, 취소된 옛 제형은 별도 항목으로 보인다
    expect(current).toContain("등록상태: 등록\n");
    expect(retired).toContain("등록상태: 등록취소");
  });

  test("product marks a product revoked when name, brand, and company all match", async () => {
    const result = await invokeCli(["product", "후라단"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("등록상태: 등록취소");
    expect(result.stdout).toContain("등록취소일: 2023-01-31");
  });

  test("product finds partial brand matches and revoked-only products", async () => {
    const product = await invokeCli(["product", "다이센"]);
    const revoked = await invokeCli(["product", "용수표"]);

    expect(product.code).toBe(0);
    expect(product.stdout).toContain("발병초부터 10일 간격 경엽처리");
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain("등록취소");
    expect(revoked.stdout).toContain("2021-09-14");
  });

  test("stats reports normalized table counts and database mtime", async () => {
    const result = await invokeCli(["stats"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("products\t3");
    expect(result.stdout).toContain("usage_rules\t3");
    expect(result.stdout).toContain("kb.sqlite mtime\t");
  });

  test("missing databases and invalid commands return exit code 1 with guidance", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      stdout.push(values.map(String).join(" "));
    });
    const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      stderr.push(values.map(String).join(" "));
    });

    try {
      expect(await runCli(["stats"], join(tempDir, "missing.sqlite"))).toBe(1);
      expect(await runCli(["unknown"], dbPath)).toBe(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(stdout).toEqual([]);
    expect(stderr.some((line) => line.includes("DB 파일이 없습니다"))).toBe(true);
    expect(stderr.some((line) => line.includes("사용법:"))).toBe(true);
  });
});

test("exportGraph writes contract nodes and applies_to edge", () => {
  const outPath = join(tempDir, "graph.json");
  const generatedPath = exportGraph({ dbPath, outPath });
  const graph = JSON.parse(readFileSync(generatedPath, "utf8")) as {
    nodes: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string; type: string }>;
  };

  expect(generatedPath).toBe(outPath);
  expect(graph.nodes.some((node) => node.id === "product:2088" && node.type === "product")).toBe(true);
  expect(graph.nodes.some((node) => node.id === "crop:4100" && node.type === "crop")).toBe(true);
  expect(graph.nodes.some((node) => node.id === "pest:탄저병" && node.type === "pest")).toBe(true);
  expect(
    graph.nodes.some(
      (node) => node.id === "product:1001-살균-6" && node.props?.revoked === true,
    ),
  ).toBe(true);
  expect(
    graph.edges.some(
      (edge) =>
        edge.source === "product:2088" &&
        edge.target === "crop:4100" &&
        edge.type === "applies_to",
    ),
  ).toBe(true);
  expect(
    graph.edges.filter(
      (edge) =>
        edge.source === "product:5000" &&
        edge.type === "has_ingredient",
    ),
  ).toEqual(
    expect.arrayContaining([
      {
        source: "product:5000",
        target: "ingredient:Azoxystrobin",
        type: "has_ingredient",
      },
      {
        source: "product:5000",
        target: "ingredient:Propiconazole",
        type: "has_ingredient",
      },
    ]),
  );
  expect(
    graph.edges.some(
      (edge) =>
        edge.source === "product:2088" &&
        edge.target === "ingredient:mancozeb" &&
        edge.type === "has_ingredient",
    ),
  ).toBe(true);
  expect(
    graph.edges.some(
      (edge) =>
        edge.source === "product:2088" &&
        edge.target === "pest:탄저병" &&
        edge.type === "controls",
    ),
  ).toBe(true);
  expect(
    graph.edges.some(
      (edge) =>
        edge.source === "crop:4100" &&
        edge.target === "cropclass:10" &&
        edge.type === "member_of",
    ),
  ).toBe(true);
  expect(
    graph.edges.some(
      (edge) =>
        edge.source === "product:2088" &&
        edge.target === "company:(주)경농" &&
        edge.type === "made_by",
    ),
  ).toBe(true);
  expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
});
