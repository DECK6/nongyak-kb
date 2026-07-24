# 구현 계획 (Codex sol 병렬 위임)

계약 고정: contracts/{api-spec.md, schema.sql, interfaces.md} + fixtures/ — 작업자는 수정 금지.

## 태스크 (독립 병렬, 파일 겹침 없음)

- **T1 fetch** — `src/fetch.ts`, `src/xml.ts`(공용 파서 아님, fetch 전용), `tests/fetch.test.ts`
  4개 서비스 페이징 전량 수집, manifest 재개, ≤4rps, 재시도, `--mock`(fixtures→data/raw 배치), `--service` 필터.
  verify: `bun test tests/fetch.test.ts` + `bun run fetch --mock` 후 data/raw 파일 존재
- **T2 normalize** — `src/normalize.ts`, `tests/normalize.test.ts`
  data/raw → kb.sqlite (contracts/schema.sql 그대로 적용, 전체 재빌드 멱등, FTS 재빌드,
  ingredient_name 파싱: eng_name "kasugamycin SL2.3 %" → "kasugamycin" best-effort,
  (pestiCode,diseaseUseSeq) 유일성 리포트 stdout).
  verify: mock raw 기준 테이블 건수 어서션
- **T3 export-ontology** — `src/export-ttl.ts`, `scripts/validate-shacl.py`, `tests/ttl.test.ts`
  kb.sqlite → dist/ontology.ttl + dist/shapes.ttl (contracts/interfaces.md 어휘), pyshacl 검증 스크립트.
  verify: mock DB에서 TTL 생성 + pyshacl exit 0
- **T4 graph+cli** — `src/export-graph.ts`, `src/cli.ts`, `tests/cli.test.ts`
  graph.json (interfaces.md 형식), CLI kb query/product/stats (TSV/JSON).
  verify: mock DB에서 `kb query "탄저병"` 결과 존재
- **T5 webapp** — `web/` (index.html, app.js, theme.css, vendored sql.js)
  통합 검색 + 용도 필터, DEXA 다크 테마 중앙 토큰.
  verify: 로컬 서버로 열어 mock kb.sqlite 검색 동작

T2~T5는 mock kb.sqlite가 필요하면 contracts/schema.sql + fixtures 값으로 자체 시드 스크립트 작성 가능
(단, 시드 스크립트는 tests/ 아래 자기 파일로 격리).

## 통합 (Fable)

1. 머지 → `bun install` → `bun test` 전체
2. E2E: fetch --mock → normalize → export → cli → 웹앱 수동 확인
3. `graphify update .`
4. 키 도착 후: 실수집 → 검증 절차(스펙 §검증 3) → STATE 갱신
