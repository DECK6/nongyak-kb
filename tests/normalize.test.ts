import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../src/normalize";

const fixtureDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const temporaryDirs: string[] = [];

function prepareRawDir(): { rawDir: string; dbPath: string } {
  const temporaryDir = mkdtempSync(join(tmpdir(), "nongyak-normalize-"));
  const rawDir = join(temporaryDir, "raw");

  temporaryDirs.push(temporaryDir);
  mkdirSync(rawDir);
  for (const service of ["SVC01", "SVC02", "SVC08", "SVC07"]) {
    cpSync(join(fixtureDir, service), join(rawDir, service), {
      recursive: true,
    });
  }

  return { rawDir, dbPath: join(temporaryDir, "kb.sqlite") };
}

function tableCount(db: Database, table: string): number {
  return (
    db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

afterEach(() => {
  for (const temporaryDir of temporaryDirs.splice(0)) {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
});

describe("normalize", () => {
  test("loads fixtures, normalizes every contracted table, and rebuilds FTS", () => {
    const opts = prepareRawDir();
    const report = normalize(opts);

    expect(report).toEqual({
      counts: {
        raw_svc01: 5,
        raw_svc02: 4,
        raw_svc08: 2,
        raw_svc07: 2,
        products: 4,
        crops: 5,
        pests: 5,
        usage_rules: 5,
        revoked_products: 2,
        analysis_methods: 2,
        fts_usage: 5,
      },
      duplicateUsageKeys: 0,
      cropCdConflicts: 0,
    });

    const db = new Database(opts.dbPath, { readonly: true });
    try {
      expect(tableCount(db, "raw_svc01")).toBe(5);
      expect(tableCount(db, "products")).toBe(4);
      expect(tableCount(db, "crops")).toBe(5);
      expect(tableCount(db, "usage_rules")).toBe(5);
      expect(tableCount(db, "revoked_products")).toBe(2);
      expect(tableCount(db, "analysis_methods")).toBe(2);

      expect(
        db
          .query(
            `SELECT ingredient_name, reg_cpnt_qnty, toxic_name
             FROM products
             WHERE pesti_code = '973'`,
          )
          .get(),
      ).toEqual({
        ingredient_name: "kasugamycin",
        reg_cpnt_qnty: "2.3",
        toxic_name: "저독성",
      });
      expect(
        db
          .query(
            `SELECT ingredient_name
             FROM products
             WHERE pesti_code = '1544'`,
          )
          .get(),
      ).toEqual({ ingredient_name: "glyphosate-isopropylammonium" });
      expect(
        db
          .query(
            `SELECT pesti_code
             FROM fts_usage
             WHERE fts_usage MATCH '탄저병'`,
          )
          .all(),
      ).toEqual([{ pesti_code: "2088" }]);
    } finally {
      db.close();
    }

    expect(normalize(opts)).toEqual(report);
  });

  test("keeps the first usage and crop rows while reporting collisions", () => {
    const opts = prepareRawDir();

    writeFileSync(
      join(opts.rawDir, "SVC01", "page-9999.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <totalCount>1</totalCount>
  <list>
    <item>
      <pestiCode>973</pestiCode>
      <diseaseUseSeq>1</diseaseUseSeq>
      <cropName>논</cropName>
      <diseaseWeedName>중복병해</diseaseWeedName>
      <pestiKorName>뒤의 행</pestiKorName>
      <cropCd>1000</cropCd>
    </item>
  </list>
</service>`,
    );

    const report = normalize(opts);

    expect(report.duplicateUsageKeys).toBe(1);
    expect(report.cropCdConflicts).toBe(1);
    expect(report.counts.raw_svc01).toBe(6);
    expect(report.counts.products).toBe(4);
    expect(report.counts.crops).toBe(5);
    expect(report.counts.usage_rules).toBe(5);

    const db = new Database(opts.dbPath, { readonly: true });
    try {
      expect(
        db.query("SELECT crop_name FROM crops WHERE crop_cd = '1000'").get(),
      ).toEqual({ crop_name: "벼" });
      expect(
        db
          .query(
            `SELECT disease_weed_name
             FROM raw_svc01
             WHERE pesti_code = '973' AND disease_use_seq = '1'
             ORDER BY rowid`,
          )
          .all(),
      ).toEqual([
        { disease_weed_name: "세균벼알마름병" },
        { disease_weed_name: "중복병해" },
      ]);
      expect(
        db
          .query(
            `SELECT pe.name
             FROM usage_rules AS u
             JOIN pests AS pe ON pe.pest_id = u.pest_id
             WHERE u.pesti_code = '973' AND u.disease_use_seq = '1'`,
          )
          .get(),
      ).toEqual({ name: "세균벼알마름병" });
    } finally {
      db.close();
    }
  });
});
