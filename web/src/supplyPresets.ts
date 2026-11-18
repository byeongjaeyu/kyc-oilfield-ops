/** 주유소에서 흔히 쓰는·파는 소모품 기본 목록 (고른 것만 품목으로 추가, 이름·단위는 추가 후 고칠 수 있음) */
export interface Preset {
  name: string;
  category: string;
  unit: string;
  hint?: string;
}

export const SUPPLY_CATEGORIES = ['판매 상품', '고객 서비스', '주유·운영', '화장실·청소', '안전·환경', '세차', '기타'] as const;

export const PRESETS: Preset[] = [
  { name: '요소수 10L', category: '판매 상품', unit: '통' },
  { name: '불스원샷 (휘발유용)', category: '판매 상품', unit: '개', hint: '연료첨가제' },
  { name: '불스원샷 (경유용)', category: '판매 상품', unit: '개', hint: '연료첨가제' },
  { name: '워셔액 1.8L (사계절)', category: '판매 상품', unit: '통' },
  { name: '워셔액 1.8L (겨울용)', category: '판매 상품', unit: '통' },
  { name: '엔진오일 1L', category: '판매 상품', unit: '통' },
  { name: '부동액 (냉각수)', category: '판매 상품', unit: '통' },
  { name: '차량용 방향제', category: '판매 상품', unit: '개' },

  { name: '생수 500ml (사은품)', category: '고객 서비스', unit: '병' },
  { name: '물티슈 (사은품)', category: '고객 서비스', unit: '개' },
  { name: '각티슈 (사은품)', category: '고객 서비스', unit: '개' },

  { name: '주유용 비닐장갑', category: '주유·운영', unit: '박스', hint: '셀프 주유기' },
  { name: '영수증·단말기 롤지', category: '주유·운영', unit: '롤' },
  { name: '웨스 (걸레)', category: '주유·운영', unit: '묶음' },
  { name: '핸드타월', category: '주유·운영', unit: '팩' },
  { name: '종량제 봉투', category: '주유·운영', unit: '장' },

  { name: '화장실 휴지', category: '화장실·청소', unit: '롤' },
  { name: '핸드솝', category: '화장실·청소', unit: '개' },
  { name: '세정제·락스', category: '화장실·청소', unit: '통' },

  { name: '유흡착포', category: '안전·환경', unit: '팩', hint: '기름 흘림 대비' },
  { name: '건조사 (마른 모래)', category: '안전·환경', unit: '포' },

  { name: '세차 샴푸', category: '세차', unit: '통' },
  { name: '왁스·코팅제', category: '세차', unit: '통' },
  { name: '세차 타월', category: '세차', unit: '장' },
];
