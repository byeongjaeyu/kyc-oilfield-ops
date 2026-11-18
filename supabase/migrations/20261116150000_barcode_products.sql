-- 바코드 → 상품 이름 캐시 (모든 주유소 공통, 상품 정보라 주유소별 데이터 아님)
--  barcode-lookup 함수(서비스 키)만 읽고 씀. 브라우저에서는 직접 못 읽음.
create table if not exists public.barcode_products (
  code text primary key check (code ~ '^[0-9A-Za-z-]{4,40}$'),
  found boolean not null default false,
  name text,
  brand text,
  spec text,           -- 용량·규격 (예: 500ml)
  category text,       -- 소모품 분류 추정
  unit text,           -- 단위 추정 (개·통·병…)
  source text,         -- 확인한 웹 출처
  looked_up_at timestamptz not null default now()
);

alter table public.barcode_products enable row level security;
revoke all on public.barcode_products from anon, authenticated;
