-- 운영 형태: 임대(임대인·임차인이 따로) / 직접 운영(소유자가 직접 운영)
--  유류 장부(fuel)는 "운영하는 사람"의 영업 정보
--   · 임대: 임차인만. 임대인은 임차인이 공유를 켤 때만 (임대인이 관리자여도 스스로 켤 수 없음)
--   · 직접 운영: 소유자(임대인 역할)가 다른 메뉴처럼 그대로 씀
alter table public.stations add column operation text not null default 'leased' check (operation in ('leased', 'self'));

alter table public.station_permissions drop constraint if exists station_permissions_fuel_tenant_only;

-- 이 주유소에 "임대인이 아닌" 임차인 회원이 있는지 (같은 사람이 두 역할을 다 가진 경우는 제외 — 데모 등)
create function private.has_other_tenant(sid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members t
     where t.station_id = sid and t.role = 'tenant'
       and not exists (select 1 from public.station_members o where o.station_id = sid and o.user_id = t.user_id and o.role = 'owner'))
$$;
revoke execute on function private.has_other_tenant(uuid) from public, anon, authenticated;

create or replace function private.can_fuel(sid uuid, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members m join public.stations s on s.id = m.station_id
      left join public.station_permissions p on p.station_id = m.station_id and p.role = m.role and p.area = 'fuel'
     where m.station_id = sid and m.user_id = auth.uid() and s.status = 'approved'
       and case
             when m.role = 'tenant' or s.operation = 'self'
               then m.is_manager or coalesce(case when write then p.can_write else p.can_read end, false)
             -- 임대 중인 주유소의 임대인: 임차인이 켠 공유만 (관리자 예외 없음)
             else coalesce(case when write then p.can_write else p.can_read end, false)
           end)
$$;

create or replace function public.my_permissions(sid uuid)
returns table (role text, is_manager boolean, area text, can_read boolean, can_write boolean)
language sql stable security definer set search_path = ''
as $$
  select m.role, m.is_manager, a.area,
         case when a.area = 'fuel' and m.role = 'owner' and s.operation = 'leased' then coalesce(p.can_read, false)
              else m.is_manager or coalesce(p.can_read, false) end,
         case when a.area = 'fuel' and m.role = 'owner' and s.operation = 'leased' then coalesce(p.can_write, false)
              else m.is_manager or coalesce(p.can_write, false) end
    from public.station_members m
    join public.stations s on s.id = m.station_id and s.status = 'approved'
    cross join unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments', 'supplies', 'fuel']) a(area)
    left join public.station_permissions p on p.station_id = m.station_id and p.role = m.role and p.area = a.area
   where m.station_id = sid and m.user_id = auth.uid()
$$;

-- 임대 중인 주유소의 "임대인 유류 장부" 권한은 유류 장부를 고칠 수 있는 임차인만 바꿈
create function public.guard_fuel_share() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.area = 'fuel' and new.role = 'owner'
     and (new.can_read is distinct from old.can_read or new.can_write is distinct from old.can_write)
     and auth.uid() is not null
     and (select operation from public.stations where id = new.station_id) = 'leased'
     and not exists (
       select 1 from public.station_members m
         left join public.station_permissions p on p.station_id = m.station_id and p.role = 'tenant' and p.area = 'fuel'
        where m.station_id = new.station_id and m.user_id = auth.uid() and m.role = 'tenant'
          and (m.is_manager or coalesce(p.can_write, false))) then
    raise exception 'fuel_share_tenant_only' using errcode = 'P0001',
      message = '임대 중인 주유소에서는 임차인만 유류 장부를 임대인에게 공유할 수 있습니다';
  end if;
  return new;
end $$;
revoke execute on function public.guard_fuel_share() from public, anon, authenticated;
create trigger guard_fuel_share before update on public.station_permissions
  for each row execute function public.guard_fuel_share();

-- 관리자가 아닌 임차인도 공유를 켜고 끌 수 있게 (해당 한 줄만)
create policy "share fuel with owner" on public.station_permissions
  for update to authenticated
  using (area = 'fuel' and role = 'owner' and (select private.can_fuel(station_id, true)))
  with check (area = 'fuel' and role = 'owner' and (select private.can_fuel(station_id, true)));

-- 운영 형태 바꾸기 규칙
create or replace function public.guard_station_operation() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.operation is distinct from old.operation then
    -- 직접 운영으로: 따로 있는 임차인이 있으면 안 됨 (임차인 장부를 임대인이 보게 되므로)
    if new.operation = 'self' and private.has_other_tenant(new.id) then
      raise exception 'operation_has_tenant' using errcode = 'P0001',
        message = '임차인 회원이 있어 직접 운영으로 바꿀 수 없습니다. 임차인을 먼저 내보내세요';
    end if;
    -- 임대로 바꾸면 소유자의 유류 장부 권한은 꺼 둠 (새 임차인이 공유를 켜기 전까지)
    if new.operation = 'leased' then
      update public.station_permissions set can_read = false, can_write = false
       where station_id = new.id and role = 'owner' and area = 'fuel';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_station_operation() from public, anon, authenticated;
create trigger guard_station_operation before update of operation on public.stations
  for each row execute function public.guard_station_operation();

-- 직접 운영 중인 주유소에는 임차인을 초대·추가할 수 없음
create function public.guard_self_tenant() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.role = 'tenant' and (select operation from public.stations where id = new.station_id) = 'self' then
    if tg_table_name = 'station_members'
       and exists (select 1 from public.station_members o where o.station_id = new.station_id and o.user_id = new.user_id and o.role = 'owner') then
      return new; -- 소유자 본인이 두 역할을 갖는 건 허용
    end if;
    raise exception 'self_operated_no_tenant' using errcode = 'P0001',
      message = '직접 운영 중인 주유소입니다. 임차인을 들이려면 주유소 설정에서 운영 형태를 임대로 바꾸세요';
  end if;
  return new;
end $$;
revoke execute on function public.guard_self_tenant() from public, anon, authenticated;
create trigger guard_self_tenant before insert on public.station_members
  for each row execute function public.guard_self_tenant();
create trigger guard_self_tenant before insert on public.station_invites
  for each row execute function public.guard_self_tenant();

