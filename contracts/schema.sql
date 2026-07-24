-- nongyak-kb SQLite schema (contract v1)
-- Raw layer: API 필드 1:1 (snake_case). Normalized layer + views가 소비자 계약.
-- 소비자(CLI/웹앱/exporter)는 반드시 v_* 뷰와 정규화 테이블만 사용한다.

-- 주의: journal_mode WAL 금지 — sql.js(웹앱)가 메인 파일만 읽으므로
-- 전체 데이터가 kb.sqlite 단일 파일에 있어야 한다.

-- ---------- raw layer (fetch 결과 그대로, rowid 테이블) ----------

CREATE TABLE IF NOT EXISTS raw_svc01 (
  pesti_code          TEXT NOT NULL,
  disease_use_seq     TEXT NOT NULL,
  crop_name           TEXT,
  disease_weed_name   TEXT,
  use_name            TEXT,
  pesti_kor_name      TEXT,
  pesti_brand_name    TEXT,
  comp_name           TEXT,
  eng_name            TEXT,
  cmpa_itm_nm         TEXT,
  indict_symbl        TEXT,
  apply_first_reg_date TEXT,
  crop_cd             TEXT,
  crop_lrcl_cd        TEXT,
  crop_lrcl_nm        TEXT,
  pesti_use           TEXT,
  dilut_unit          TEXT,
  use_suittime        TEXT,
  use_num             TEXT,
  wafindex            TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_svc01_key ON raw_svc01(pesti_code, disease_use_seq);

CREATE TABLE IF NOT EXISTS raw_svc02 (
  pesti_code        TEXT PRIMARY KEY,   -- pestiCode당 1회 수집
  disease_use_seq   TEXT NOT NULL,      -- 조회에 사용한 seq
  pesti_kor_name    TEXT,
  use_name          TEXT,
  comp_name         TEXT,
  pesti_brand_name  TEXT,
  pesti_eng_name    TEXT,
  reg_cpnt_qnty     TEXT,
  toxic_gubun       TEXT,
  toxic_name        TEXT,
  fish_toxic_gubun  TEXT
);

CREATE TABLE IF NOT EXISTS raw_svc08 (
  prdlst_regist_no  TEXT,
  cmpa_itm_nm       TEXT,
  pesti_kor_name    TEXT,
  eng_name          TEXT,
  regist_stndrd     TEXT,
  pesti_brand_name  TEXT,
  comp_name         TEXT,
  prdlst_abl_de     TEXT
);

CREATE TABLE IF NOT EXISTS raw_svc07 (
  tchprduct_ingr_sn   TEXT,
  gnrl_nm_eng         TEXT,
  gnrl_nm_kor         TEXT,
  procs_anals_fil_infn TEXT,
  amnd_fil_nm         TEXT
);

-- ---------- normalized layer ----------

CREATE TABLE IF NOT EXISTS products (
  pesti_code        TEXT PRIMARY KEY,
  pesti_kor_name    TEXT NOT NULL,      -- 품목명
  brand_name        TEXT,               -- 상표명
  comp_name         TEXT,               -- 회사명
  eng_name          TEXT,               -- 주성분 원문 "kasugamycin SL2.3 %"
  ingredient_name   TEXT,               -- eng_name에서 best-effort 파싱한 성분명
  cmpa_itm_nm       TEXT,               -- 제조/수입
  indict_symbl      TEXT,               -- 작용기작
  use_name          TEXT,               -- 용도(살균제/살충제/제초제 등)
  apply_first_reg_date TEXT,
  reg_cpnt_qnty     TEXT,               -- SVC02: 주성분 함량
  toxic_gubun       TEXT,               -- SVC02: 독성 구분(Ⅰ~Ⅳ)
  toxic_name        TEXT,               -- SVC02: 독성명
  fish_toxic_gubun  TEXT                -- SVC02: 어독성
);

CREATE TABLE IF NOT EXISTS crops (
  crop_cd       TEXT PRIMARY KEY,
  crop_name     TEXT NOT NULL,
  crop_lrcl_cd  TEXT,
  crop_lrcl_nm  TEXT                    -- 작물분류명(미곡류 등)
);

CREATE TABLE IF NOT EXISTS pests (
  pest_id   INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE        -- 적용병해충명(잡초 포함)
);

CREATE TABLE IF NOT EXISTS usage_rules (
  pesti_code      TEXT NOT NULL REFERENCES products(pesti_code),
  disease_use_seq TEXT NOT NULL,
  crop_cd         TEXT REFERENCES crops(crop_cd),
  pest_id         INTEGER REFERENCES pests(pest_id),
  pesti_use       TEXT,                 -- 사용적기/방법
  dilut_unit      TEXT,                 -- 희석배수(10a당 사용량)
  use_suittime    TEXT,                 -- 안전사용기준: 수확 n일 전
  use_num         TEXT,                 -- 안전사용기준: n회 이내
  wafindex        TEXT,
  PRIMARY KEY (pesti_code, disease_use_seq)
);

CREATE TABLE IF NOT EXISTS revoked_products (
  prdlst_regist_no TEXT PRIMARY KEY,
  pesti_kor_name   TEXT,
  eng_name         TEXT,
  regist_stndrd    TEXT,
  brand_name       TEXT,
  comp_name        TEXT,
  cmpa_itm_nm      TEXT,
  revoked_date     TEXT                 -- prdlstAblDe
);

CREATE TABLE IF NOT EXISTS analysis_methods (
  tchprduct_ingr_sn TEXT PRIMARY KEY,
  gnrl_nm_eng       TEXT,
  gnrl_nm_kor       TEXT,
  doc_info          TEXT,               -- procsAnalsFilInfn
  doc_url           TEXT                -- amndFilNm
);

-- ---------- 소비자 계약 뷰 ----------

CREATE VIEW IF NOT EXISTS v_usage AS
SELECT
  u.pesti_code, u.disease_use_seq,
  p.pesti_kor_name, p.brand_name, p.comp_name, p.use_name,
  p.eng_name, p.ingredient_name, p.indict_symbl,
  p.toxic_name, p.fish_toxic_gubun, p.reg_cpnt_qnty,
  c.crop_name, c.crop_lrcl_nm,
  pe.name AS pest_name,
  u.pesti_use, u.dilut_unit, u.use_suittime, u.use_num
FROM usage_rules u
JOIN products p  ON p.pesti_code = u.pesti_code
LEFT JOIN crops c  ON c.crop_cd = u.crop_cd
LEFT JOIN pests pe ON pe.pest_id = u.pest_id;

-- FTS5: v_usage 내용 검색용 (normalize 마지막 단계에서 재빌드)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_usage USING fts5(
  pesti_code UNINDEXED, disease_use_seq UNINDEXED,
  crop_name, pest_name, pesti_kor_name, brand_name, comp_name, eng_name, use_name,
  tokenize = 'unicode61'
);
