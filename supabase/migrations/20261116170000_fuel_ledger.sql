-- 유류 장부 (임차인 전용) 1단계 — 매입 단가와 마진
--  매입가·마진은 운영하는 임차인의 영업 정보라 임대인에게는 보이지 않는다.
--  임대인이 주유소 관리자여도 열 수 없다 (다른 메뉴와 달리 관리자 예외 없음).

-- ── 권한 영역 'fuel' ──
alter table public.station_permissions drop constraint station_permissions_area_check;
alter table public.station_permissions add constraint station_permissions_area_check
  check (area in ('prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel'));
alter table public.station_permissions add constraint station_permissions_fuel_tenant_only
  check (not (area = 'fuel' and role = 'owner' and (can_read or can_write)));
insert into public.station_permissions (station_id, role, area, can_read, can_write)
select s.id, r, 'fuel', r = 'tenant', r = 'tenant' from public.stations s cross join unnest(array['owner', 'tenant']) r
on conflict do nothing;

create or replace function private.seed_station(sid uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.station_permissions (station_id, role, area, can_read, can_write)
  select sid, r, a,
         not (r = 'owner' and a = 'fuel'),
         not (r = 'tenant' and a = 'payments') and not (r = 'owner' and a = 'fuel')
    from unnest(array['owner', 'tenant']) r,
         unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel']) a
  on conflict do nothing;
  if not exists (select 1 from public.inspections i where i.station_id = sid) then
    insert into public.inspections (station_id, name, party)
    values (sid, '토양오염도 검사', '임차인'), (sid, '저장탱크 누출검사', '임차인'), (sid, '위험물 정기점검', '임차인'),
           (sid, '소방시설 자체점검', '임차인'), (sid, '화재보험 만기', ''), (sid, '환경책임보험 만기', '');
  end if;
end $$;
revoke execute on function private.seed_station(uuid) from public, anon, authenticated;

-- 임차인 자격으로만 열리는 영역: 임차인 관리자이거나, 임차인 역할에 유류 장부 권한이 켜져 있을 때
create function private.can_fuel(sid uuid, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members m join public.stations s on s.id = m.station_id
     where m.station_id = sid and m.user_id = auth.uid() and m.role = 'tenant' and s.status = 'approved'
       and (m.is_manager or exists (
         select 1 from public.station_permissions p
          where p.station_id = m.station_id and p.role = 'tenant' and p.area = 'fuel'
            and case when write then p.can_write else p.can_read end)))
$$;
revoke execute on function private.can_fuel(uuid, boolean) from public, anon;
grant execute on function private.can_fuel(uuid, boolean) to authenticated;

create or replace function public.my_permissions(sid uuid)
returns table (role text, is_manager boolean, area text, can_read boolean, can_write boolean)
language sql stable security definer set search_path = ''
as $$
  select m.role, m.is_manager, a.area,
         case when a.area = 'fuel' and m.role <> 'tenant' then false else m.is_manager or coalesce(p.can_read, false) end,
         case when a.area = 'fuel' and m.role <> 'tenant' then false else m.is_manager or coalesce(p.can_write, false) end
    from public.station_members m
    join public.stations s on s.id = m.station_id and s.status = 'approved'
    cross join unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel']) a(area)
    left join public.station_permissions p on p.station_id = m.station_id and p.role = m.role and p.area = a.area
   where m.station_id = sid and m.user_id = auth.uid()
$$;

-- ── 유류 설정 (주유소마다 한 줄) ──
create table public.fuel_settings (
  station_id uuid primary key references public.stations (id) on delete cascade,
  -- 카드 수수료율(%). 마진에서 뺀다
  card_fee_pct numeric(4, 2) not null default 1.5 check (card_fee_pct between 0 and 10),
  updated_at timestamptz not null default now()
);
create trigger touch_fuel_settings before update on public.fuel_settings
  for each row execute function public.touch_updated_at();

-- ── 매입 기록 ── 단가는 부가세 포함 원/L. 리터는 몰라도 됨(단가만 적어도 마진 계산 가능)
create table public.fuel_purchases (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  fuel text not null check (fuel in ('gasoline', 'diesel', 'premium', 'kerosene')),
  bought_on date not null default ((now() at time zone 'Asia/Seoul')::date),
  unit_cost numeric(8, 2) not null check (unit_cost > 0 and unit_cost < 10000),
  liters numeric(10, 1) check (liters > 0),
  supplier text not null default '',
  note text not null default '',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fuel_purchases_station_idx on public.fuel_purchases (station_id, fuel, bought_on desc);
create index fuel_purchases_created_by_idx on public.fuel_purchases (created_by);

alter table public.fuel_settings enable row level security;
alter table public.fuel_purchases enable row level security;
create policy "read fuel settings" on public.fuel_settings for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add fuel settings" on public.fuel_settings for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "edit fuel settings" on public.fuel_settings for update to authenticated
  using ((select private.can_fuel(station_id, true))) with check ((select private.can_fuel(station_id, true)));
create policy "read fuel purchases" on public.fuel_purchases for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add fuel purchases" on public.fuel_purchases for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "edit fuel purchases" on public.fuel_purchases for update to authenticated
  using ((select private.can_fuel(station_id, true))) with check ((select private.can_fuel(station_id, true)));
create policy "delete fuel purchases" on public.fuel_purchases for delete to authenticated using ((select private.can_fuel(station_id, true)));
