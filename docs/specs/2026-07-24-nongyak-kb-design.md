# nongyak-kb 설계 스펙 (2026-07-24, 사용자 승인)

## 목적

농촌진흥청 PSIS(농약안전정보시스템) OpenAPI의 농약 데이터를 오프라인 전량 확보하고,
정규화 DB + 온톨로지로 파생하여 ① RAG/에이전트 지식베이스 ② 로컬 검색 웹앱으로 쓴다.

참고: 사용자가 "농정원 농약 API"로 지칭했으나 실 데이터 원천은 농진청 PSIS OpenAPI
(농정원 EPIS는 농식품 공공데이터 포털 운영 주체). 키는 PSIS에서 직접 발급
(SVC01 농약등록정보·SVC07 공정분석법·SVC08 등록취소 3건 신청 완료, 승인 대기 — 2026-07-24 기준).

## 데이터 원천 (contracts/api-spec.md에 확정 명세)

| 서비스 | 내용 | 규모(매뉴얼 기준) |
|---|---|---|
| SVC01 | 농약등록정보 목록 (작물×병해충×제품 = 안전사용기준 행 단위) | ~89,365건 |
| SVC02 | 제품 상세 (독성·어독성·주성분 함량) | 고유 pestiCode당 1회 |
| SVC08 | 등록취소 농약 | 소량 |
| SVC07 | 농약 공정분석법 (성분별 PDF 링크) | ~502건 |

## 아키텍처 (승인된 A안)

```
fetch.ts ──> data/raw/*.xml (+manifest.json, 재개 가능, ≤4rps)
normalize.ts ──> data/kb.sqlite (raw층 + 정규화층 + FTS5 + v_* 뷰)
export-ttl.ts ──> dist/ontology.ttl + shapes.ttl (SHACL 검증)
export-graph.ts ──> dist/graph.json (graphify 호환)
cli.ts ──> kb query/product/stats (RAG 소비 인터페이스)
web/ ──> 정적 검색 웹앱 (sql.js, DEXA 다크 테마)
```

계약 문서: `contracts/api-spec.md`(API), `contracts/schema.sql`(DB), `contracts/interfaces.md`(CLI·graph·TTL·웹).
소비자는 정규화층 + v_* 뷰만 사용. raw층 스키마 변화는 normalize 내부에 격리.

## 키 승인 전 개발 전략

`fixtures/`의 매뉴얼 예제 기반 샘플 XML로 `--mock` 모드 개발·테스트.
키 도착 시: 실수집 → 미확정 사항 검증(계약 문서의 "미확정 사항" 절) → 필요 시 normalize만 수정.

## 검증 (완료 기준)

1. `bun test` 전체 통과 (모듈별 픽스처 테스트)
2. mock 파이프라인 E2E: fetch --mock → normalize → export → cli 쿼리 성공
3. 실데이터(키 도착 후): 수집 건수 == totalCount 대사, (pestiCode,diseaseUseSeq) 유일성 리포트,
   SHACL 통과, 샘플 20건 PSIS 웹 대조 팩트체크
4. 웹앱: 검색 시나리오 3종(작물+병해충, 품목명, 회사) 동작

## 비범위 (백로그)

- MCP 서버화, 식약처 MRL(잔류허용기준) 연계, sql.js-httpvfs 청크 로딩, GitHub Pages 배포
