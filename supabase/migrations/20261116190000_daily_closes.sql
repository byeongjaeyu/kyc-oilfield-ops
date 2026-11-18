-- 유류 장부 3단계 — 일 마감 (임차인 전용)
--  하루 판매량(L)과 카드·현금 매출, 카드사에서 실제 들어온 돈을 적어 맞춰 본다
create table public.daily_closes (
  station_id uuid not null references public.stations (id) on delete cascade,
  close_on date not null,
  gasoline_l numeric(10, 1) check (gasoline_l >= 0),
  diesel_l numeric(10, 1) check (diesel_l >= 0),
  premium_l numeric(10, 1) check (premium_l >= 0),
  kerosene_l numeric(10, 1) check (kerosene_l >= 0),
  card_sales bigint not null default 0 check (card_sales >= 0),
  cash_sales bigint not null default 0 check (cash_sales >= 0),
  -- 외상·상품권·포인트 등
  other_sales bigint not null default 0 check (other_sales >= 0),
  -- 그날 카드 매출분으로 카드사에서 실제 들어온 돈 (확인 전에는 비움)
  card_deposit bigint check (card_deposit >= 0),
  note text not null default '',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (station_id, close_on)
);
create index daily_closes_created_by_idx on public.daily_closes (created_by);
create trigger touch_daily_closes before update on public.daily_closes
  for each row execute function public.touch_updated_at();

alter table public.daily_closes enable row level security;
create policy "read daily closes" on public.daily_closes for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add daily closes" on public.daily_closes for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "edit daily closes" on public.daily_closes for update to authenticated
  using ((select private.can_fuel(station_id, true))) with check ((select private.can_fuel(station_id, true)));
create policy "delete daily closes" on public.daily_closes for delete to authenticated using ((select private.can_fuel(station_id, true)));
