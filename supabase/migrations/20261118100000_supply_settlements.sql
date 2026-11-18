-- 소모품 주문·정산
--  1) 입고 기록에 거래처와 받은 단가를 남김 → 거래처별 월 입고 내역(월말 정산용)
--  2) 받은 단가·거래처는 나중에 고칠 수 있음 (수량·재고는 그대로, 장부는 지우지 않음)
--  3) 거래처별 월 정산 완료 기록

alter table public.supply_moves
  add column vendor_id uuid references public.supply_vendors (id) on delete set null,
  add column unit_cost bigint check (unit_cost >= 0);
create index supply_moves_vendor_idx on public.supply_moves (vendor_id, created_at);

-- 지금까지의 입고는 품목에 지정된 거래처·단가로 채움 (대략치)
update public.supply_moves m
   set vendor_id = i.vendor_id, unit_cost = i.unit_cost
  from public.supply_items i
 where i.id = m.item_id and m.kind = 'in' and m.vendor_id is null;

-- 입고·보정 때 거래처·단가를 따로 넣지 않으면 품목 값으로 채움
create or replace function public.apply_supply_move() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  cur numeric;
  v uuid;
  c bigint;
begin
  select station_id, stock, vendor_id, unit_cost into new.station_id, cur, v, c
    from public.supply_items where id = new.item_id for update;
  if new.kind in ('in', 'out') and new.qty < 0 then
    raise exception '수량은 0보다 커야 합니다.' using errcode = 'P0001';
  end if;
  if new.kind in ('in', 'adjust') then
    new.vendor_id := coalesce(new.vendor_id, v);
    new.unit_cost := coalesce(new.unit_cost, c);
  else
    new.vendor_id := null;
    new.unit_cost := null;
  end if;
  if new.vendor_id is not null
     and not exists (select 1 from public.supply_vendors where id = new.vendor_id and station_id = new.station_id) then
    raise exception '다른 주유소의 거래처입니다.' using errcode = 'P0001';
  end if;
  new.stock_before := cur;
  new.stock_after := case new.kind
    when 'in' then cur + new.qty
    when 'out' then cur - new.qty
    when 'count' then new.qty
    else cur + new.qty
  end;
  update public.supply_items set stock = new.stock_after where id = new.item_id;
  return new;
end $$;
revoke execute on function public.apply_supply_move() from public, anon, authenticated;

-- 고칠 수 있는 칸은 거래처·단가뿐
create function public.guard_supply_move_fix() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.vendor_id is not null
     and not exists (select 1 from public.supply_vendors where id = new.vendor_id and station_id = old.station_id) then
    raise exception '다른 주유소의 거래처입니다.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.guard_supply_move_fix() from public, anon, authenticated;
create trigger guard_supply_move_fix before update on public.supply_moves
  for each row execute function public.guard_supply_move_fix();

revoke update on public.supply_moves from anon, authenticated;
grant update (vendor_id, unit_cost) on public.supply_moves to authenticated;
create policy "fix move cost" on public.supply_moves
  for update to authenticated
  using ((select private.can(station_id, 'supplies', true)))
  with check ((select private.can(station_id, 'supplies', true)));

-- ── 거래처별 월 정산 ──
create table public.supply_settlements (
  vendor_id uuid not null references public.supply_vendors (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  station_id uuid not null references public.stations (id) on delete cascade,
  amount bigint not null check (amount >= 0),
  note text not null default '' check (length(note) <= 200),
  settled_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  primary key (vendor_id, month)
);
create index supply_settlements_station_idx on public.supply_settlements (station_id, month);
create index supply_settlements_created_by_idx on public.supply_settlements (created_by);

-- 주유소는 거래처에서 가져옴
create function public.settlement_station() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  select station_id into new.station_id from public.supply_vendors where id = new.vendor_id;
  if new.station_id is null then
    raise exception '거래처가 없습니다.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.settlement_station() from public, anon, authenticated;
create trigger settlement_station before insert or update on public.supply_settlements
  for each row execute function public.settlement_station();

alter table public.supply_settlements enable row level security;
create policy "read settlements" on public.supply_settlements
  for select to authenticated using ((select private.can(station_id, 'supplies')));
create policy "write settlements" on public.supply_settlements
  for all to authenticated
  using ((select private.can(station_id, 'supplies', true)))
  with check ((select private.can(station_id, 'supplies', true)));
