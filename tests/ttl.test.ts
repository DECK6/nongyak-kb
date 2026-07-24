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
