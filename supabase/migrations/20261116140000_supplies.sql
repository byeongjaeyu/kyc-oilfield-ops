-- 소모품 재고·주문 — 품목(기본 목록 + 직접 추가), 거래처, 입고·판매·실사 기록, 주문서
--  재고는 기록(supply_moves)이 들어올 때 트리거가 품목의 stock 을 고친다
--  발주점 아래로 떨어지면 기한 알림 잡이 한 번 알리고, 다시 채워지면 알림 표시를 지운다

-- ── 권한 영역 'supplies' 추가 ──
alter table public.station_permissions drop constraint station_permissions_area_check;
alter table public.station_permissions add constraint station_permissions_area_check
  check (area in ('prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies'));
insert into public.station_permissions (station_id, role, area, can_read, can_write)
select s.id, r, 'supplies', true, true from public.stations s cross join unnest(array['owner', 'tenant']) r
on conflict do nothing;

create or replace function private.seed_station(sid uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.station_permissions (station_id, role, area, can_read, can_write)
  select sid, r, a, true, not (r = 'tenant' and a = 'payments')
    from unnest(array['owner', 'tenant']) r,
         unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies']) a
  on conflict do nothing;
  if not exists (select 1 from public.inspections i where i.station_id = sid) then
    insert into public.inspections (station_id, name, party)
    values (sid, '토양오염도 검사', '임차인'), (sid, '저장탱크 누출검사', '임차인'), (sid, '위험물 정기점검', '임차인'),
           (sid, '소방시설 자체점검', '임차인'), (sid, '화재보험 만기', ''), (sid, '환경책임보험 만기', '');
  end if;
end $$;
revoke execute on function private.seed_station(uuid) from public, anon, authenticated;

create or replace function public.my_permissions(sid uuid)
returns table (role text, is_manager boolean, area text, can_read boolean, can_write boolean)
language sql stable security definer set search_path = ''
as $$
  select m.role, m.is_manager, a.area,
         m.is_manager or coalesce(p.can_read, false),
         m.is_manager or coalesce(p.can_write, false)
    from public.station_members m
    join public.stations s on s.id = m.station_id and s.status = 'approved'
    cross join unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies']) a(area)
    left join public.station_permissions p on p.station_id = m.station_id and p.role = m.role and p.area = a.area
   where m.station_id = sid and m.user_id = auth.uid()
$$;

-- ── 거래처 ──
create table public.supply_vendors (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  contact_name text not null default '',
  phone text not null default '',
  email text not null default '',
  order_method text not null default 'sms' check (order_method in ('sms', 'email', 'kakao', 'phone', 'etc')),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index supply_vendors_station_id_idx on public.supply_vendors (station_id);

-- ── 품목 ──
create table public.supply_items (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  category text not null default '기타',
  unit text not null default '개',
  barcode text,
  vendor_id uuid references public.supply_vendors (id) on delete set null,
  stock numeric(12, 2) not null default 0,
  reorder_point numeric(12, 2) not null default 0 check (reorder_point >= 0),
  order_qty numeric(12, 2) not null default 0 check (order_qty >= 0),
  unit_cost bigint check (unit_cost >= 0),
  sell_price bigint check (sell_price >= 0),
  active boolean not null default true,
  note text not null default '',
  -- 발주점 알림을 보낸 시각 (재고가 다시 발주점 위로 오르면 비움)
  low_alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_id, barcode)
);
create index supply_items_station_id_idx on public.supply_items (station_id);
create index supply_items_vendor_id_idx on public.supply_items (vendor_id);
create trigger touch_supply_items before update on public.supply_items
  for each row execute function public.touch_updated_at();

-- 발주점 위로 올라가면 알림 표시를 지움
create function public.reset_low_alert() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.stock > new.reorder_point then
    new.low_alerted_at := null;
  end if;
  return new;
end $$;
create trigger reset_low_alert before update of stock, reorder_point on public.supply_items
  for each row execute function public.reset_low_alert();

-- ── 입고·판매·실사 기록 ──
--  in: 입고(+), out: 판매·사용(-), count: 실사(그 수로 맞춤), adjust: 보정(±)
create table public.supply_moves (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  item_id uuid not null references public.supply_items (id) on delete cascade,
  kind text not null check (kind in ('in', 'out', 'count', 'adjust')),
  qty numeric(12, 2) not null,
  stock_before numeric(12, 2),
  stock_after numeric(12, 2),
  note text not null default '',
  order_id uuid,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index supply_moves_item_idx on public.supply_moves (item_id, created_at);
create index supply_moves_station_id_idx on public.supply_moves (station_id);
create index supply_moves_created_by_idx on public.supply_moves (created_by);

create function public.apply_supply_move() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare cur numeric;
begin
  select station_id, stock into new.station_id, cur from public.supply_items where id = new.item_id for update;
  if new.kind in ('in', 'out') and new.qty < 0 then
    raise exception '수량은 0보다 커야 합니다.' using errcode = 'P0001';
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
create trigger apply_supply_move before insert on public.supply_moves
  for each row execute function public.apply_supply_move();

-- ── 주문서 ──
create table public.supply_orders (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  vendor_id uuid references public.supply_vendors (id) on delete set null,
  vendor_name text not null default '',
  status text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  -- [{item_id, name, qty, unit}]
  lines jsonb not null default '[]',
  message text not null default '',
  sent_at timestamptz,
  received_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index supply_orders_station_id_idx on public.supply_orders (station_id, created_at);
create index supply_orders_vendor_id_idx on public.supply_orders (vendor_id);
create index supply_orders_created_by_idx on public.supply_orders (created_by);
alter table public.supply_moves add constraint supply_moves_order_fk
  foreign key (order_id) references public.supply_orders (id) on delete set null;
create index supply_moves_order_id_idx on public.supply_moves (order_id);

-- ── RLS: 보기 = 소모품 보기 권한, 기록·수정 = 소모품 수정 권한 ──
alter table public.supply_vendors enable row level security;
alter table public.supply_items enable row level security;
alter table public.supply_moves enable row level security;
alter table public.supply_orders enable row level security;

create policy "read vendors" on public.supply_vendors
  for select to authenticated using ((select private.can(station_id, 'supplies')));
create policy "write vendors" on public.supply_vendors
  for all to authenticated
  using ((select private.can(station_id, 'supplies', true)))
  with check ((select private.can(station_id, 'supplies', true)));

create policy "read items" on public.supply_items
  for select to authenticated using ((select private.can(station_id, 'supplies')));
create policy "write items" on public.supply_items
  for all to authenticated
  using ((select private.can(station_id, 'supplies', true)))
  with check ((select private.can(station_id, 'supplies', true)));

create policy "read moves" on public.supply_moves
  for select to authenticated using ((select private.can(station_id, 'supplies')));
-- 기록은 트리거가 station_id 를 품목에서 가져오므로, 품목 기준으로 권한 확인
create policy "add moves" on public.supply_moves
  for insert to authenticated
  with check (exists (select 1 from public.supply_items i where i.id = item_id and private.can(i.station_id, 'supplies', true))
              and created_by = (select auth.uid()));
-- 기록은 지우지 않음 (장부). 잘못 넣었으면 보정(adjust)으로 되돌림

create policy "read orders" on public.supply_orders
  for select to authenticated using ((select private.can(station_id, 'supplies')));
create policy "write orders" on public.supply_orders
  for all to authenticated
  using ((select private.can(station_id, 'supplies', true)))
  with check ((select private.can(station_id, 'supplies', true)));
