-- 유류 장부 2단계 — 탱크 재고와 발주 타이밍 (임차인 전용)
--  재고 추정 = 마지막 측정값 + 그 뒤 입고(매입 기록의 수량) − 하루 평균 판매량 × 지난 날

create table public.fuel_tanks (
  station_id uuid not null references public.stations (id) on delete cascade,
  fuel text not null check (fuel in ('gasoline', 'diesel', 'premium', 'kerosene')),
  capacity_l numeric(10, 1) not null check (capacity_l > 0),
  -- 이 양 아래로 내려가면 발주할 때
  reorder_l numeric(10, 1) not null default 0 check (reorder_l >= 0),
  updated_at timestamptz not null default now(),
  primary key (station_id, fuel)
);
create trigger touch_fuel_tanks before update on public.fuel_tanks
  for each row execute function public.touch_updated_at();

create table public.fuel_dips (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  fuel text not null check (fuel in ('gasoline', 'diesel', 'premium', 'kerosene')),
  measured_at timestamptz not null default now(),
  liters numeric(10, 1) not null check (liters >= 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fuel_dips_station_idx on public.fuel_dips (station_id, fuel, measured_at desc);
create index fuel_dips_created_by_idx on public.fuel_dips (created_by);

alter table public.fuel_tanks enable row level security;
alter table public.fuel_dips enable row level security;
create policy "read fuel tanks" on public.fuel_tanks for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add fuel tanks" on public.fuel_tanks for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "edit fuel tanks" on public.fuel_tanks for update to authenticated
  using ((select private.can_fuel(station_id, true))) with check ((select private.can_fuel(station_id, true)));
create policy "delete fuel tanks" on public.fuel_tanks for delete to authenticated using ((select private.can_fuel(station_id, true)));
create policy "read fuel dips" on public.fuel_dips for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add fuel dips" on public.fuel_dips for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "delete fuel dips" on public.fuel_dips for delete to authenticated using ((select private.can_fuel(station_id, true)));
