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
      droppedRevoked: 0,
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

  test("stores the earliest registration date, not the first row's", () => {
    const opts = prepareRawDir();

    // applyFirstRegDate는 사용기준별로 다르게 온다 — 제품 속성은 최소값이어야 한다
    writeFileSync(
      join(opts.rawDir, "SVC01", "page-9996.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <totalCount>1</totalCount>
  <list>
    <item>
      <pestiCode>973</pestiCode>
      <diseaseUseSeq>8888</diseaseUseSeq>
      <cropName>벼</cropName>
      <cropCd>1000</cropCd>
      <diseaseWeedName>도열병</diseaseWeedName>
      <pestiKorName>가스가마이신 액제</pestiKorName>
      <applyFirstRegDate>19800115</applyFirstRegDate>
    </item>
  </list>
</service>`,
    );

    normalize(opts);

    const db = new Database(opts.dbPath, { readonly: true });
    try {
      expect(
        db
          .query("SELECT apply_first_reg_date FROM products WHERE pesti_code = '973'")
          .get(),
      ).toEqual({ apply_first_reg_date: "19800115" });
    } finally {
      db.close();
    }
  });

  test("reports revoked rows dropped by the registration-number primary key", () => {
    const opts = prepareRawDir();

    // PSIS는 같은 품목등록번호를 서로 다른 제품에 쓰는 경우가 있다
    writeFileSync(
      join(opts.rawDir, "SVC08", "page-9997.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <totalCount>1</totalCount>
  <list>
    <item>
      <prdlstRegistNo>29-살충-2</prdlstRegistNo>
      <pestiKorName>페노뷰카브 유제</pestiKorName>
      <pestiBrandName>해솜비피</pestiBrandName>
      <compName>(주)유피엘리미티드코리아</compName>
      <prdlstAblDe>2021-12-07</prdlstAblDe>
    </item>
    <item>
      <prdlstRegistNo>29-살충-2</prdlstRegistNo>
      <pestiKorName>클로르피리포스 미탁제</pestiKorName>
      <pestiBrandName>거포</pestiBrandName>
      <compName>한국마간(주)</compName>
      <prdlstAblDe>2021-09-10</prdlstAblDe>
    </item>
  </list>
</service>`,
    );

    const report = normalize(opts);

    expect(report.droppedRevoked).toBe(1);
  });

  test("keeps crop names that the API supplies without a crop code", () => {
    const opts = prepareRawDir();

    writeFileSync(
      join(opts.rawDir, "SVC01", "page-9998.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <totalCount>1</totalCount>
  <list>
    <item>
      <pestiCode>973</pestiCode>
      <diseaseUseSeq>7001</diseaseUseSeq>
      <cropName>두류</cropName>
      <diseaseWeedName>잡초</diseaseWeedName>
      <pestiKorName>가스가마이신 액제</pestiKorName>
    </item>
  </list>
</service>`,
    );

    normalize(opts);

    const db = new Database(opts.dbPath, { readonly: true });
    try {
      expect(
        db
          .query(
            `SELECT crop_name
             FROM v_usage
             WHERE pesti_code = '973' AND disease_use_seq = '7001'`,
          )
          .get(),
      ).toEqual({ crop_name: "두류" });
    } finally {
      db.close();
    }
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
