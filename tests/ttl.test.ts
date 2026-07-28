import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Parser } from "n3";
import { exportTtl } from "../src/export-ttl";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds ingredient IRIs that survive a Turtle round trip", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "nongyak-kb-iri-"));
  const dbPath = join(temporaryDirectory, "kb.sqlite");
  const outDir = join(temporaryDirectory, "dist");
  temporaryDirectories.push(temporaryDirectory);

  const db = new Database(dbPath, { create: true });
  db.exec(
    readFileSync(resolve(import.meta.dir, "../contracts/schema.sql"), "utf8"),
  );
  // 미생물 농약 성분명에는 '/'와 '^'가 들어간다 — IRI로 그대로 쓰면 경로가 깨진다
  db.query(
    `INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, use_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "9001",
    "바실루스 수화제",
    "미생물킹",
    "(주)바이오",
    "Bacillus subtilis DBB-1501 WP 1.0x10^9 cfu/g",
    "Bacillus subtilis DBB-1501 WP 1.0x10^9 cfu/g",
    "살균제",
  );
  db.close();

  const { ontologyPath } = exportTtl({ dbPath, outDir });
  const ontology = readFileSync(ontologyPath, "utf8");
  const ingredientIris = new Parser()
    .parse(ontology)
    .map((quad) => quad.subject.value)
    .filter((value) => value.includes("ingredient-"));

  expect(ingredientIris.length).toBeGreaterThan(0);
  for (const iri of ingredientIris) {
    expect(iri.slice(iri.indexOf("ingredient-"))).not.toContain("/");
    expect(iri).not.toContain("^");
  }
});

test("gives names that differ only by punctuation distinct IRIs", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "nongyak-kb-uniq-"));
  const dbPath = join(temporaryDirectory, "kb.sqlite");
  const outDir = join(temporaryDirectory, "dist");
  temporaryDirectories.push(temporaryDirectory);

  const db = new Database(dbPath, { create: true });
  db.exec(
    readFileSync(resolve(import.meta.dir, "../contracts/schema.sql"), "utf8"),
  );
  // 잡초 목록 병해충명은 쉼표 유무로만 갈리는 쌍이 실제로 존재한다
  const insertPest = db.query("INSERT INTO pests (pest_id, name) VALUES (?, ?)");
  insertPest.run(1, "일년생잡초(가막사리, 물달개비, 자귀풀, 피)");
  insertPest.run(2, "일년생잡초(가막사리, 물달개비, 자귀풀 피)");
  db.close();

  const { ontologyPath } = exportTtl({ dbPath, outDir });
  const pestIris = new Set(
    new Parser()
      .parse(readFileSync(ontologyPath, "utf8"))
      .map((quad) => quad.subject.value)
      .filter((value) => value.includes("/pest-")),
  );

  expect(pestIris.size).toBe(2);
});

test("exports one hasIngredient relation per compound constituent", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "nongyak-kb-compound-"));
  const dbPath = join(temporaryDirectory, "kb.sqlite");
  const outDir = join(temporaryDirectory, "dist");
  temporaryDirectories.push(temporaryDirectory);

  const db = new Database(dbPath, { create: true });
  db.exec(
    readFileSync(resolve(import.meta.dir, "../contracts/schema.sql"), "utf8"),
  );
  db.query(
    `INSERT INTO products (
      pesti_code, pesti_kor_name, eng_name, ingredient_name
    ) VALUES (?, ?, ?, ?)`,
  ).run(
    "5000",
    "아족시스트로빈·프로피코나졸 유현탁제",
    "Azoxystrobin.Propiconazole SE 18.71(7.01+11.7) %",
    "Azoxystrobin.Propiconazole",
  );
  db.close();

  const { ontologyPath } = exportTtl({ dbPath, outDir });
  const ingredientObjects = new Parser()
    .parse(readFileSync(ontologyPath, "utf8"))
    .filter(
      (quad) =>
        quad.subject.value.endsWith("product-5000") &&
        quad.predicate.value.endsWith("hasIngredient"),
    )
    .map((quad) => quad.object.value);

  expect(ingredientObjects).toHaveLength(2);
  expect(ingredientObjects).toEqual(
    expect.arrayContaining([
      expect.stringContaining("ingredient-Azoxystrobin"),
      expect.stringContaining("ingredient-Propiconazole"),
    ]),
  );
});

test("exports fixture-based normalized data and SHACL shapes as valid Turtle", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "nongyak-kb-ttl-"));
  const dbPath = join(temporaryDirectory, "kb.sqlite");
  const outDir = join(temporaryDirectory, "dist");
  temporaryDirectories.push(temporaryDirectory);

  const db = new Database(dbPath, { create: true });
  db.exec(
    readFileSync(resolve(import.meta.dir, "../contracts/schema.sql"), "utf8"),
  );
  db.query(
    `INSERT INTO products (
      pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
      ingredient_name, cmpa_itm_nm, indict_symbl, use_name,
      apply_first_reg_date, reg_cpnt_qnty, toxic_gubun, toxic_name,
      fish_toxic_gubun
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "973",
    "가스가마이신 액제",
    "가스가민",
    "(주)동방아그로",
    "Kasugamycin",
    "kasugamycin",
    "제조",
    "라3",
    "살균제",
    "19950311",
    "2.3",
    "Ⅳ",
    "저독성",
    "Ⅲ급",
  );
  db.query(
    `INSERT INTO crops (
      crop_cd, crop_name, crop_lrcl_cd, crop_lrcl_nm
    ) VALUES (?, ?, ?, ?)`,
  ).run("1000", "벼", "01", "미곡류");
  db.query("INSERT INTO pests (pest_id, name) VALUES (?, ?)").run(
    1,
    "세균벼알마름병",
  );
  db.query(
    `INSERT INTO usage_rules (
      pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
      dilut_unit, use_suittime, use_num, wafindex
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "973",
    "1",
    "1000",
    1,
    "출수직전부터 7일 간격 경엽처리",
    "1000배 -",
    "수확 14일 전까지",
    "5회 이내",
    "1",
  );
  db.close();

  const { ontologyPath, shapesPath } = exportTtl({ dbPath, outDir });
  const ontology = readFileSync(ontologyPath, "utf8");
  const shapes = readFileSync(shapesPath, "utf8");

  expect(ontology).toContain("nyk:Product");
  expect(ontology).toContain("nyk:UsageRule");
  expect(ontology).toContain("가스가마이신 액제");
  expect(ontology).toContain("세균벼알마름병");
  expect(ontology).toContain("nykd:usage-973-1");
  expect(existsSync(shapesPath)).toBe(true);
  expect(shapes).toContain("sh:NodeShape");
  expect(shapes).toContain("sh:or");
  expect(new Parser().parse(ontology).length).toBeGreaterThan(0);
  expect(new Parser().parse(shapes).length).toBeGreaterThan(0);
});
