# PSIS OpenAPI 계약 (확정 — 공식 기술명세서 HWP에서 추출, 2026-07-24)

원문 매뉴얼: 농촌진흥청 농약안전정보시스템(PSIS) OpenAPI 기술명세서 v1.0
발급 키: `.env`의 `PSIS_API_KEY` (승인 대기 중 — 도착 전까지 `--mock` 모드로 개발)

## 공통

- 전송: REST GET, XML 응답(serviceType=AA001 계열), SSL
- 제한: 초당 최대 10 tps (구현은 4 rps 이하로 제한), 평균 응답 500ms
- 페이징: `displayCount` (최대 50), `startPoint` — **주의: 매뉴얼엔 "페이지 번호"로 적혀 있으나 실제로는 1-기반 아이템 오프셋** (2026-07-24 실측: startPoint=2는 2번째 행부터, 페이지 N은 startPoint=(N-1)*displayCount+1). SVC01·SVC08 동일 확인
- 에러: 응답에 `errorCode`/`errorMsg` 요소 존재 시 오류
  - ERR_101/102/104: 키 문제 → 즉시 중단(fatal)
  - ERR_103/201: 파라미터 문제 → 버그, 중단
  - ERR_901: 서버 오류 → 백오프 재시도(최대 5회)

## SVC01 농약등록정보 목록

- URL: `https://psis.rda.go.kr/openApi/service.do`
- 필수: `apiKey`, `serviceCode=SVC01`, `serviceType=AA001`(XML), `displayCount`, `startPoint`
- 선택: `useName`, `cropName`(+`cropCheck`, cropName2~4), `diseaseWeedName`, `similarFlag`, `pestiKorName`, `pestiBrandName`, `compName`
- 전량 수집: 검색어 전부 빈값으로 페이징 (매뉴얼 예시 totalCount=89,365)
- 응답 엔벨로프:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<service>
  <totalCount>89365</totalCount>
  <list>
    <item>
      <pestiCode>973</pestiCode>          <!-- 품목 상세 조회키 -->
      <diseaseUseSeq>1</diseaseUseSeq>    <!-- 병해충 상세 조회키 -->
      <cropName>벼</cropName>
      <diseaseWeedName>세균벼알마름병</diseaseWeedName>
      <useName>살균제</useName>
      <pestiKorName>가스가마이신 액제</pestiKorName>
      <pestiBrandName>가스가민</pestiBrandName>
      <compName>(주)동방아그로</compName>
      <engName>kasugamycin SL2.3 %</engName>  <!-- 주성분(일반명)+제형+함량 -->
      <cmpaItmNm>제조</cmpaItmNm>              <!-- 제조/수입 구분 -->
      <indictSymbl>라3</indictSymbl>           <!-- 작용기작 -->
      <applyFirstRegDate>19950311</applyFirstRegDate>
      <cropCd>1000</cropCd>
      <cropLrclCd>01</cropLrclCd>
      <cropLrclNm>미곡류</cropLrclNm>
      <pestiUse>출수직전부터 7일 간격 경엽처리</pestiUse>
      <dilutUnit>1000배 -</dilutUnit>          <!-- 희석배수(10a당 사용량) -->
      <useSuittime>수확 14일 전까지</useSuittime> <!-- 안전사용기준(수확 n일 전) -->
      <useNum>5회 이내</useNum>                 <!-- 안전사용기준(n회 이내) -->
      <wafindex>1</wafindex>                   <!-- 표에는 없고 예제에만 존재 -->
    </item>
  </list>
</service>
```

## SVC02 농약등록정보 상세

- URL: `https://psis.rda.go.kr/openApi/service.do`
- 필수: `apiKey`, `serviceCode=SVC02`, `pestiCode`, `diseaseUseSeq` (serviceType 없음)
- 목록에 없는 제품 수준 추가 필드: `pestiEngName`, `regCpntQnty`(주성분 함량), `toxicGubun`, `toxicName`(인축독성), `fishToxicGubun`(어독성)
- 수집 전략: SVC01 완료 후 고유 `pestiCode`당 1회만 호출(해당 코드의 첫 diseaseUseSeq 사용) — 독성·함량은 제품 수준 속성이므로
- 응답: `<service>` 아래 플랫 필드 (list 없음)

```xml
<service>
  <pestiKorName>아세타미프리드 미탁제</pestiKorName>
  <useName>살충제</useName>
  <compName>(주)경농</compName>
  <pestiBrandName>일순위</pestiBrandName>
  <pestiEngName>Acetamiprid</pestiEngName>
  <regCpntQnty>10</regCpntQnty>
  <toxicGubun>Ⅲ</toxicGubun>
  <toxicName>보통독성</toxicName>
  <fishToxicGubun>Ⅲ급</fishToxicGubun>
  <cropName>밤</cropName>
  <diseaseWeedName>갈색날개매미충(ULV)</diseaseWeedName>
  <pestiUse>다발생기 경엽처리</pestiUse>
  <dilutUnit>60배 3ℓ/10a</dilutUnit>
  <useSuittime>수확 14일전</useSuittime>
  <useNum>2회 이내</useNum>
</service>
```

## SVC08 등록취소 농약정보

- URL: `https://psis.rda.go.kr/openApi/cnclAgchm.do` (엔드포인트 다름!)
- 필수: `apiKey`, `serviceCode=SVC08`, `serviceType=AA001`, `displayCount`, `startPoint`
- 선택: `pestiKorName`, `pestiBrandName`, `compName`
- 응답: SVC01과 같은 `<service><totalCount><list><item>` 구조

```xml
<item>
  <prdlstRegistNo>1001-살균-6</prdlstRegistNo>  <!-- 등록번호 -->
  <cmpaItmNm>수입</cmpaItmNm>
  <pestiKorName>엑스12485473 액상제</pestiKorName>
  <engName>X12485473</engName>
  <registStndrd>5%</registStndrd>              <!-- 등록기준(함량) -->
  <pestiBrandName>용수표</pestiBrandName>
  <compName>(주)농촌진흥청</compName>
  <prdlstAblDe>2021-09-14</prdlstAblDe>        <!-- 등록취소일 -->
</item>
```

## SVC07 농약 공정분석법

- URL: `https://psis.rda.go.kr/openApi/hmpgContService.do` (엔드포인트 다름!)
- 필수: `apiKey`, `serviceCode=SVC07`, `serviceType=AA007`(XML), `displayCount`, `startPoint`
- 선택: `gnrlNmEng`, `gnrlNmKor`, `procsAnalsFilInfn`
- 응답: `<service><totalCount><list><item>` (매뉴얼 예시 totalCount=502)

```xml
<item>
  <tchprductIngrSn>1143</tchprductIngrSn>
  <gnrlNmEng>Flumioxazin</gnrlNmEng>
  <gnrlNmKor>플루미옥사진</gnrlNmKor>
  <amndFilNm>http://psis.rda.go.kr/uploadDocs/tchpr/tchpr_20131129101618.pdf</amndFilNm>
</item>
```
(응답에 `procsAnalsFilInfn` 필드도 존재 가능 — 실데이터에서 확인)

## 미확정 사항 (실데이터 도착 시 검증)

1. SVC01에서 `(pestiCode, diseaseUseSeq)` 조합이 전역 유일한지 (같은 품목의 브랜드별 중복 여부) → normalize 시 유일성 리포트 출력
2. `wafindex` 의미
3. SVC07 응답의 `procsAnalsFilInfn` 존재 여부
