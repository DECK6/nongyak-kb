import { Database } from "bun:sqlite";
import { XMLParser } from "fast-xml-parser";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingredientName } from "./ingredients";

export interface NormalizeReport {
  counts: Record<string, number>;
  duplicateUsageKeys: number;
  cropCdConflicts: number;
  droppedRevoked: number;
}

type XmlRecord = Record<string, unknown>;

interface Svc01Row {
  pesti_code: string;
  disease_use_seq: string;
  crop_name: string | null;
  disease_weed_name: string | null;
  use_name: string | null;
  pesti_kor_name: string | null;
  pesti_brand_name: string | null;
  comp_name: string | null;
  eng_name: string | null;
  cmpa_itm_nm: string | null;
  indict_symbl: string | null;
  apply_first_reg_date: string | null;
  crop_cd: string | null;
  crop_lrcl_cd: string | null;
  crop_lrcl_nm: string | null;
  pesti_use: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
  wafindex: string | null;
}

interface Svc02Row {
  pesti_code: string;
  disease_use_seq: string;
  pesti_kor_name: string | null;
  use_name: string | null;
  comp_name: string | null;
  pesti_brand_name: string | null;
  pesti_eng_name: string | null;
  reg_cpnt_qnty: string | null;
  toxic_gubun: string | null;
  toxic_name: string | null;
  fish_toxic_gubun: string | null;
}

interface Svc08Row {
  prdlst_regist_no: string | null;
  cmpa_itm_nm: string | null;
  pesti_kor_name: string | null;
  eng_name: string | null;
  regist_stndrd: string | null;
  pesti_brand_name: string | null;
  comp_name: string | null;
  prdlst_abl_de: string | null;
}

interface Svc07Row {
  tchprduct_ingr_sn: string | null;
  gnrl_nm_eng: string | null;
  gnrl_nm_kor: string | null;
  procs_anals_fil_infn: string | null;
  amnd_fil_nm: string | null;
}

function asRecord(value: unknown, source: string): XmlRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: XML 객체가 필요합니다.`);
  }
  return value as XmlRecord;
}

function textValue(
  record: XmlRecord,
  key: string,
  source: string,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${source}: ${key} 필드는 문자열이어야 합니다.`);
  }
  return value;
}

function requiredText(
  value: string | null,
  field: string,
  source: string,
): string {
  if (value === null) {
    throw new Error(`${source}: 필수 필드 ${field}가 없습니다.`);
  }
  return value;
}

function readService(
  parser: XMLParser,
  filePath: string,
): XmlRecord {
  const parsed: unknown = parser.parse(readFileSync(filePath, "utf8"));
  const service = asRecord(
    asRecord(parsed, filePath).service,
    `${filePath} <service>`,
  );
  const errorCode = textValue(service, "errorCode", filePath);

  if (errorCode !== null) {
    throw new Error(
      `${filePath}: API 오류 ${errorCode} ${textValue(service, "errorMsg", filePath) ?? ""}`.trim(),
    );
  }
  return service;
}

function listItems(service: XmlRecord, source: string): XmlRecord[] {
  if (
    service.list === undefined ||
    service.list === null ||
    service.list === ""
  ) {
    return [];
  }

  const item = asRecord(service.list, `${source} <list>`).item;
  if (item === undefined || item === null || item === "") {
    return [];
  }
  return (Array.isArray(item) ? item : [item]).map((value) =>
    asRecord(value, `${source} <item>`),
  );
}

function xmlFiles(rawDir: string, service: string): string[] {
  const serviceDir = resolve(rawDir, service);
  if (!existsSync(serviceDir)) {
    return [];
  }
  return readdirSync(serviceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".xml")
    .map((entry) => resolve(serviceDir, entry.name))
    .sort();
}

// PSIS가 작물명만 주고 cropCd를 비워 보내는 행이 있다(대분류명 "두류"/"서류" 등).
// crops의 PK가 코드라 그대로 두면 작물명이 통째로 유실되므로, 실제 코드와 겹치지
// 않는 접두사로 이름 기반 코드를 합성해 보존한다.
function cropCode(row: { crop_cd: string | null; crop_name: string | null }): string | null {
  if (row.crop_cd !== null) {
    return row.crop_cd;
  }
  return row.crop_name === null ? null : `NC-${row.crop_name}`;
}

function rowCount(db: Database, table: string): number {
  return Number(
    (
      db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

export function normalize(opts?: {
  rawDir?: string;
  dbPath?: string;
}): NormalizeReport {
  const rawDir = resolve(opts?.rawDir ?? "data/raw");
  const dbPath = resolve(opts?.dbPath ?? "data/kb.sqlite");
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  });
  const svc01Rows: Svc01Row[] = [];
  const svc02Rows: Svc02Row[] = [];
  const svc08Rows: Svc08Row[] = [];
  const svc07Rows: Svc07Row[] = [];
  const firstDiseaseUseSeq = new Map<string, string>();

  for (const filePath of xmlFiles(rawDir, "SVC01")) {
    for (const item of listItems(readService(parser, filePath), filePath)) {
      const pestiCode = requiredText(
        textValue(item, "pestiCode", filePath),
        "pestiCode",
        filePath,
      );
      const diseaseUseSeq = requiredText(
        textValue(item, "diseaseUseSeq", filePath),
        "diseaseUseSeq",
        filePath,
      );

      firstDiseaseUseSeq.set(
        pestiCode,
        firstDiseaseUseSeq.get(pestiCode) ?? diseaseUseSeq,
      );
      svc01Rows.push({
        pesti_code: pestiCode,
        disease_use_seq: diseaseUseSeq,
        crop_name: textValue(item, "cropName", filePath),
        disease_weed_name: textValue(item, "diseaseWeedName", filePath),
        use_name: textValue(item, "useName", filePath),
        pesti_kor_name: textValue(item, "pestiKorName", filePath),
        pesti_brand_name: textValue(item, "pestiBrandName", filePath),
        comp_name: textValue(item, "compName", filePath),
        eng_name: textValue(item, "engName", filePath),
        cmpa_itm_nm: textValue(item, "cmpaItmNm", filePath),
        indict_symbl: textValue(item, "indictSymbl", filePath),
        apply_first_reg_date: textValue(
          item,
          "applyFirstRegDate",
          filePath,
        ),
        crop_cd: textValue(item, "cropCd", filePath),
        crop_lrcl_cd: textValue(item, "cropLrclCd", filePath),
        crop_lrcl_nm: textValue(item, "cropLrclNm", filePath),
        pesti_use: textValue(item, "pestiUse", filePath),
        dilut_unit: textValue(item, "dilutUnit", filePath),
        use_suittime: textValue(item, "useSuittime", filePath),
        use_num: textValue(item, "useNum", filePath),
        wafindex: textValue(item, "wafindex", filePath),
      });
    }
  }

  for (const filePath of xmlFiles(rawDir, "SVC02")) {
    const service = readService(parser, filePath);
    const pestiCode =
      textValue(service, "pestiCode", filePath) ??
      basename(filePath, extname(filePath));
    const diseaseUseSeq =
      textValue(service, "diseaseUseSeq", filePath) ??
      firstDiseaseUseSeq.get(pestiCode) ??
      null;

    svc02Rows.push({
      pesti_code: pestiCode,
      disease_use_seq: requiredText(
        diseaseUseSeq,
        "diseaseUseSeq 또는 대응하는 SVC01 행",
        filePath,
      ),
      pesti_kor_name: textValue(service, "pestiKorName", filePath),
      use_name: textValue(service, "useName", filePath),
      comp_name: textValue(service, "compName", filePath),
      pesti_brand_name: textValue(service, "pestiBrandName", filePath),
      pesti_eng_name: textValue(service, "pestiEngName", filePath),
      reg_cpnt_qnty: textValue(service, "regCpntQnty", filePath),
      toxic_gubun: textValue(service, "toxicGubun", filePath),
      toxic_name: textValue(service, "toxicName", filePath),
      fish_toxic_gubun: textValue(service, "fishToxicGubun", filePath),
    });
  }

  for (const filePath of xmlFiles(rawDir, "SVC08")) {
    for (const item of listItems(readService(parser, filePath), filePath)) {
      svc08Rows.push({
        prdlst_regist_no: textValue(item, "prdlstRegistNo", filePath),
        cmpa_itm_nm: textValue(item, "cmpaItmNm", filePath),
        pesti_kor_name: textValue(item, "pestiKorName", filePath),
        eng_name: textValue(item, "engName", filePath),
        regist_stndrd: textValue(item, "registStndrd", filePath),
        pesti_brand_name: textValue(item, "pestiBrandName", filePath),
        comp_name: textValue(item, "compName", filePath),
        prdlst_abl_de: textValue(item, "prdlstAblDe", filePath),
      });
    }
  }

  for (const filePath of xmlFiles(rawDir, "SVC07")) {
    for (const item of listItems(readService(parser, filePath), filePath)) {
      svc07Rows.push({
        tchprduct_ingr_sn: textValue(item, "tchprductIngrSn", filePath),
        gnrl_nm_eng: textValue(item, "gnrlNmEng", filePath),
        gnrl_nm_kor: textValue(item, "gnrlNmKor", filePath),
        procs_anals_fil_infn: textValue(
          item,
          "procsAnalsFilInfn",
          filePath,
        ),
        amnd_fil_nm: textValue(item, "amndFilNm", filePath),
      });
    }
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  const db = new Database(dbPath, { create: true });
  let duplicateUsageKeys = 0;
  let cropCdConflicts = 0;
  let droppedRevoked = 0;

  try {
    db.exec(
      readFileSync(
        fileURLToPath(new URL("../contracts/schema.sql", import.meta.url)),
        "utf8",
      ),
    );
    db.exec("PRAGMA foreign_keys = ON");

    const rebuild = db.transaction(() => {
      const insertRawSvc01 = db.query(`
        INSERT INTO raw_svc01 (
          pesti_code, disease_use_seq, crop_name, disease_weed_name,
          use_name, pesti_kor_name, pesti_brand_name, comp_name, eng_name,
          cmpa_itm_nm, indict_symbl, apply_first_reg_date, crop_cd,
          crop_lrcl_cd, crop_lrcl_nm, pesti_use, dilut_unit, use_suittime,
          use_num, wafindex
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      for (const row of svc01Rows) {
        insertRawSvc01.run(
          row.pesti_code,
          row.disease_use_seq,
          row.crop_name,
          row.disease_weed_name,
          row.use_name,
          row.pesti_kor_name,
          row.pesti_brand_name,
          row.comp_name,
          row.eng_name,
          row.cmpa_itm_nm,
          row.indict_symbl,
          row.apply_first_reg_date,
          row.crop_cd,
          row.crop_lrcl_cd,
          row.crop_lrcl_nm,
          row.pesti_use,
          row.dilut_unit,
          row.use_suittime,
          row.use_num,
          row.wafindex,
        );
      }

      const insertRawSvc02 = db.query(`
        INSERT INTO raw_svc02 (
          pesti_code, disease_use_seq, pesti_kor_name, use_name, comp_name,
          pesti_brand_name, pesti_eng_name, reg_cpnt_qnty, toxic_gubun,
          toxic_name, fish_toxic_gubun
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of svc02Rows) {
        insertRawSvc02.run(
          row.pesti_code,
          row.disease_use_seq,
          row.pesti_kor_name,
          row.use_name,
          row.comp_name,
          row.pesti_brand_name,
          row.pesti_eng_name,
          row.reg_cpnt_qnty,
          row.toxic_gubun,
          row.toxic_name,
          row.fish_toxic_gubun,
        );
      }

      const insertRawSvc08 = db.query(`
        INSERT INTO raw_svc08 (
          prdlst_regist_no, cmpa_itm_nm, pesti_kor_name, eng_name,
          regist_stndrd, pesti_brand_name, comp_name, prdlst_abl_de
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of svc08Rows) {
        insertRawSvc08.run(
          row.prdlst_regist_no,
          row.cmpa_itm_nm,
          row.pesti_kor_name,
          row.eng_name,
          row.regist_stndrd,
          row.pesti_brand_name,
          row.comp_name,
          row.prdlst_abl_de,
        );
      }

      const insertRawSvc07 = db.query(`
        INSERT INTO raw_svc07 (
          tchprduct_ingr_sn, gnrl_nm_eng, gnrl_nm_kor,
          procs_anals_fil_infn, amnd_fil_nm
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of svc07Rows) {
        insertRawSvc07.run(
          row.tchprduct_ingr_sn,
          row.gnrl_nm_eng,
          row.gnrl_nm_kor,
          row.procs_anals_fil_infn,
          row.amnd_fil_nm,
        );
      }

      const usageRows: Svc01Row[] = [];
      const usageKeys = new Set<string>();
      for (const row of svc01Rows) {
        const key = JSON.stringify([row.pesti_code, row.disease_use_seq]);
        if (usageKeys.has(key)) {
          duplicateUsageKeys++;
          continue;
        }
        usageKeys.add(key);
        usageRows.push(row);
      }

      const svc02ByPestiCode = new Map<string, Svc02Row>();
      for (const row of svc02Rows) {
        if (!svc02ByPestiCode.has(row.pesti_code)) {
          svc02ByPestiCode.set(row.pesti_code, row);
        }
      }

      const insertProduct = db.query(`
        INSERT INTO products (
          pesti_code, pesti_kor_name, brand_name, comp_name, eng_name,
          ingredient_name, cmpa_itm_nm, indict_symbl, use_name,
          apply_first_reg_date, reg_cpnt_qnty, toxic_gubun, toxic_name,
          fish_toxic_gubun
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // applyFirstRegDate는 사용기준(작물×병해충)별로 다르게 온다. 첫 행 값을 제품
      // 속성으로 승격하면 API 페이지 순서에 따라 값이 달라지므로 최소값을 쓴다.
      const earliestRegDate = new Map<string, string>();
      for (const row of svc01Rows) {
        const date = row.apply_first_reg_date;
        if (date === null || date === "") {
          continue;
        }
        const previous = earliestRegDate.get(row.pesti_code);
        if (previous === undefined || date < previous) {
          earliestRegDate.set(row.pesti_code, date);
        }
      }

      const productCodes = new Set<string>();
      for (const row of svc01Rows) {
        if (productCodes.has(row.pesti_code)) {
          continue;
        }
        productCodes.add(row.pesti_code);
        const detail = svc02ByPestiCode.get(row.pesti_code);
        insertProduct.run(
          row.pesti_code,
          requiredText(
            row.pesti_kor_name,
            "pestiKorName",
            `SVC01 pestiCode=${row.pesti_code}`,
          ),
          row.pesti_brand_name,
          row.comp_name,
          row.eng_name,
          ingredientName(row.eng_name),
          row.cmpa_itm_nm,
          row.indict_symbl,
          row.use_name,
          earliestRegDate.get(row.pesti_code) ?? row.apply_first_reg_date,
          detail?.reg_cpnt_qnty ?? null,
          detail?.toxic_gubun ?? null,
          detail?.toxic_name ?? null,
          detail?.fish_toxic_gubun ?? null,
        );
      }

      const firstCropName = new Map<string, string>();
      for (const row of svc01Rows) {
        const cropCd = cropCode(row);
        if (cropCd === null || row.crop_name === null) {
          continue;
        }
        const existingName = firstCropName.get(cropCd);
        if (existingName === undefined) {
          firstCropName.set(cropCd, row.crop_name);
        } else if (existingName !== row.crop_name) {
          cropCdConflicts++;
        }
      }

      const insertCrop = db.query(`
        INSERT INTO crops (crop_cd, crop_name, crop_lrcl_cd, crop_lrcl_nm)
        VALUES (?, ?, ?, ?)
      `);
      const cropCodes = new Set<string>();
      for (const row of usageRows) {
        const cropCd = cropCode(row);
        if (cropCd === null || row.crop_name === null || cropCodes.has(cropCd)) {
          continue;
        }
        cropCodes.add(cropCd);
        insertCrop.run(
          cropCd,
          row.crop_name,
          row.crop_lrcl_cd,
          row.crop_lrcl_nm,
        );
      }

      const insertPest = db.query(
        "INSERT INTO pests (pest_id, name) VALUES (?, ?)",
      );
      const pestIds = new Map<string, number>();
      for (const row of usageRows) {
        if (
          row.disease_weed_name === null ||
          pestIds.has(row.disease_weed_name)
        ) {
          continue;
        }
        const pestId = pestIds.size + 1;
        pestIds.set(row.disease_weed_name, pestId);
        insertPest.run(pestId, row.disease_weed_name);
      }

      const insertUsage = db.query(`
        INSERT INTO usage_rules (
          pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
          dilut_unit, use_suittime, use_num, wafindex
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of usageRows) {
        const cropCd = cropCode(row);
        insertUsage.run(
          row.pesti_code,
          row.disease_use_seq,
          cropCd !== null && cropCodes.has(cropCd) ? cropCd : null,
          row.disease_weed_name === null
            ? null
            : (pestIds.get(row.disease_weed_name) ?? null),
          row.pesti_use,
          row.dilut_unit,
          row.use_suittime,
          row.use_num,
          row.wafindex,
        );
      }

      const insertRevoked = db.query(`
        INSERT OR IGNORE INTO revoked_products (
          prdlst_regist_no, pesti_kor_name, eng_name, regist_stndrd,
          brand_name, comp_name, cmpa_itm_nm, revoked_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // PSIS는 같은 품목등록번호를 서로 다른 제품에 재사용한다. schema의 PK가
      // 이를 걸러내므로, 몇 건이 버려졌는지 리포트로 드러낸다.
      for (const row of svc08Rows) {
        const inserted = insertRevoked.run(
          requiredText(
            row.prdlst_regist_no,
            "prdlstRegistNo",
            "SVC08 item",
          ),
          row.pesti_kor_name,
          row.eng_name,
          row.regist_stndrd,
          row.pesti_brand_name,
          row.comp_name,
          row.cmpa_itm_nm,
          row.prdlst_abl_de,
        );
        if (inserted.changes === 0) {
          droppedRevoked++;
        }
      }

      const insertAnalysis = db.query(`
        INSERT OR IGNORE INTO analysis_methods (
          tchprduct_ingr_sn, gnrl_nm_eng, gnrl_nm_kor, doc_info, doc_url
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of svc07Rows) {
        insertAnalysis.run(
          requiredText(
            row.tchprduct_ingr_sn,
            "tchprductIngrSn",
            "SVC07 item",
          ),
          row.gnrl_nm_eng,
          row.gnrl_nm_kor,
          row.procs_anals_fil_infn,
          row.amnd_fil_nm,
        );
      }

      db.exec("DELETE FROM fts_usage");
      db.exec(`
        INSERT INTO fts_usage (
          pesti_code, disease_use_seq, crop_name, pest_name, pesti_kor_name,
          brand_name, comp_name, eng_name, use_name
        )
        SELECT
          pesti_code, disease_use_seq, crop_name, pest_name, pesti_kor_name,
          brand_name, comp_name, eng_name, use_name
        FROM v_usage
      `);
    });

    rebuild();

    const countTables = [
      "raw_svc01",
      "raw_svc02",
      "raw_svc08",
      "raw_svc07",
      "products",
      "crops",
      "pests",
      "usage_rules",
      "revoked_products",
      "analysis_methods",
      "fts_usage",
    ];
    const counts: Record<string, number> = {};
    for (const table of countTables) {
      counts[table] = rowCount(db, table);
    }

    return { counts, duplicateUsageKeys, cropCdConflicts, droppedRevoked };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const report = normalize();

  console.log("정규화 완료");
  for (const [table, count] of Object.entries(report.counts)) {
    console.log(`- ${table}: ${count.toLocaleString("ko-KR")}건`);
  }
  console.log(`- 중복 사용 키: ${report.duplicateUsageKeys.toLocaleString("ko-KR")}건`);
  console.log(`- 작물 코드 이름 충돌: ${report.cropCdConflicts.toLocaleString("ko-KR")}건`);
  console.log(`- 등록번호 중복으로 버린 등록취소: ${report.droppedRevoked.toLocaleString("ko-KR")}건`);
}
