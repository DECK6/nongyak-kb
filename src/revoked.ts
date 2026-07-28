// 등록취소 목록(SVC08)은 품목등록번호로 식별되고 products는 품목코드만 가지므로
// 두 테이블은 이름으로만 대조할 수 있다. 같은 회사가 같은 상표를 유지한 채 제형만
// 바꿔 재등록하는 사례가 많아(실데이터에서 현행 등록 35건이 여기 해당) 상표·회사만
// 비교하면 유효한 등록 제품을 등록취소로 오표시한다. 품목명·상표명·회사명이 모두
// 일치할 때만 등록취소로 판정한다.

export type RevokedMatchable = {
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
};

export type RevokedRecord = {
  pesti_kor_name: string | null;
  brand_name: string | null;
  comp_name: string | null;
};

export function matchesRevoked(
  product: RevokedMatchable,
  revoked: RevokedRecord,
): boolean {
  return Boolean(
    product.brand_name &&
      product.comp_name &&
      revoked.pesti_kor_name === product.pesti_kor_name &&
      revoked.brand_name === product.brand_name &&
      revoked.comp_name === product.comp_name,
  );
}
