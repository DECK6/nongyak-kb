# 모듈 간 인터페이스 계약 v1

## 파일 레이아웃

```
nongyak-kb/
  contracts/        # 이 계약 문서들 (수정 금지 — 변경은 통합자 승인)
  fixtures/         # API 응답 샘플 XML (mock 모드·테스트 공용)
  data/
    raw/SVC01/page-0001.xml ...   # fetch 산출물 (원문 그대로)
    raw/SVC02/<pestiCode>.xml
    raw/SVC08/page-0001.xml
    raw/SVC07/page-0001.xml
    raw/manifest.json             # 수집 상태 (재개용)
    kb.sqlite                     # normalize 산출물
  dist/
    ontology.ttl                  # export 산출물
    shapes.ttl
    graph.json
  src/                            # fetch.ts normalize.ts export-ttl.ts export-graph.ts cli.ts
  web/                            # 정적 웹앱 (index.html, sql.js)
  scripts/validate-shacl.py
  tests/
```

## 실행 커맨드 (package.json scripts)

- `bun run fetch [--service SVC01] [--mock]` — mock이면 fixtures/를 data/raw/로 복사 배치
- `bun run normalize` — data/raw/ → data/kb.sqlite (contracts/schema.sql 적용, 전체 재빌드, 멱등)
- `bun run export` — kb.sqlite → dist/ontology.ttl + dist/graph.json
- `bun run cli -- <cmd>` — 아래 CLI 명세
- `bun test`

## manifest.json (fetch 재개 상태)

```json
{
  "SVC01": { "totalCount": 89365, "pageSize": 50, "fetchedPages": [1,2], "done": false, "updatedAt": "ISO8601" },
  "SVC02": { "pending": ["973"], "done": ["1024"], "updatedAt": "..." },
  "SVC08": { "totalCount": 33, "fetchedPages": [1], "done": true },
  "SVC07": { "totalCount": 502, "fetchedPages": [1], "done": false }
}
```

## CLI 명세 (RAG 소비 계약 — 에이전트가 Bash로 호출)

- `kb query "<검색어>"` — fts_usage 매치, 기본 20건. 공백 구분 토큰을 각각 phrase-escape 후
  AND 결합 (다중 컬럼 매치 지원, FTS 연산자는 리터럴 취급). 출력: TSV (헤더 포함:
  `품목명 상표명 회사 작물 병해충 희석배수 사용적기 안전사용기준`)
- `kb query "<검색어>" --json` — v_usage 행 JSON 배열, 결과 없음은 `[]`
- `kb product "<품목명|상표명>"` — 제품 상세 + 해당 usage_rules 전부, 등록취소 여부 표시
- `kb stats` — 테이블별 건수, 수집일
- 종료코드: 결과 없음 0(빈 출력), 오류 1

## graph.json (graphify 호환)

```json
{
  "nodes": [
    { "id": "product:973", "type": "product", "label": "가스가마이신 액제(가스가민)",
      "props": { "company": "...", "toxicity": "...", "useName": "살균제" } },
    { "id": "ingredient:kasugamycin", "type": "ingredient", "label": "kasugamycin" },
    { "id": "crop:1000", "type": "crop", "label": "벼" },
    { "id": "cropclass:01", "type": "crop_class", "label": "미곡류" },
    { "id": "pest:세균벼알마름병", "type": "pest", "label": "세균벼알마름병" },
    { "id": "company:(주)동방아그로", "type": "company", "label": "(주)동방아그로" }
  ],
  "edges": [
    { "source": "product:973", "target": "ingredient:kasugamycin", "type": "has_ingredient" },
    { "source": "product:973", "target": "crop:1000", "type": "applies_to",
      "props": { "diseaseUseSeq": "1", "dilutUnit": "1000배 -", "useSuittime": "수확 14일 전까지", "useNum": "5회 이내" } },
    { "source": "product:973", "target": "pest:세균벼알마름병", "type": "controls" },
    { "source": "crop:1000", "target": "cropclass:01", "type": "member_of" },
    { "source": "product:973", "target": "company:(주)동방아그로", "type": "made_by" }
  ]
}
```

## TTL 어휘

- prefix `nyk: <https://deck6ix.github.io/nongyak-kb/ontology#>`, 인스턴스는 `nykd: <.../data/>`
- 클래스: `nyk:Product, nyk:ActiveIngredient, nyk:Crop, nyk:CropClass, nyk:Pest, nyk:Company, nyk:UsageRule, nyk:RevokedProduct, nyk:AnalysisMethod`
- UsageRule은 재화(reified): `nyk:hasProduct, nyk:hasCrop, nyk:hasPest, nyk:dilution, nyk:applicationTiming, nyk:preHarvestInterval, nyk:maxApplications`
- Product 속성: `nyk:brandName, nyk:companyName(→nyk:Company로 관계도), nyk:hasIngredient, nyk:toxicity, nyk:fishToxicity, nyk:modeOfAction, nyk:registeredDate, rdfs:label`
- shapes.ttl: 각 클래스 필수속성 SHACL (UsageRule은 hasProduct 필수, hasCrop/hasPest 중 최소 1개)
- 검증: `python3 scripts/validate-shacl.py dist/ontology.ttl dist/shapes.ttl` (pyshacl, exit 0/1)

## 웹앱 계약

- `web/` 정적 파일만, 빌드 산출물 없이 열리게 (sql.js CDN 대신 vendored)
- `data/kb.sqlite`를 fetch로 로드 (경로 `../data/kb.sqlite`, 배포 시 web/ 옆에 복사)
- 검색: 작물/병해충/품목·상표/회사 통합 검색창 + 용도 필터 → v_usage와 동일 필드의 결과 테이블
- 테마: DEXA 다크(Ink 배경 + 시안 액센트, 하드웨어 패널 모티프). 색·간격 토큰은 `web/theme.css` :root CSS 변수로 중앙화 (hex 산재 금지)
