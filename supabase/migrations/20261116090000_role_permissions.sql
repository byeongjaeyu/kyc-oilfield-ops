-- 역할별 권한을 표로 관리 — 임대인이 회원 관리 화면에서 임차인 권한을 켜고 끔
--  영역: prices(가격 비교) land(부지 가치) policy(정책 요약) contracts(계약 일정) inspections(법정 검사)
--  임대인은 항상 전부 가능 (잠김 방지). 회원 관리는 이 표와 무관하게 임대인 전용.

create table public.role_permissions (
  role text not null check (role in ('owner', 'tenant')),
  area text not null check (area in ('prices', 'land', 'policy', 'contracts', 'inspections')),
  can_read boolean not null default false,
  can_write boolean not null default false,
  primary key (role, area),
  check (not can_write or can_read)
);

-- 지금은 임차인에게 전부 허용 (나중에 화면에서 제한)
insert into public.role_permissions (role, area, can_read, can_write)
select r, a, true, true
from unnest(array['owner', 'tenant']) r, unnest(array['prices', 'land', 'policy', 'contracts', 'inspections']) a;

create function private.can(area text, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case private.my_role()
    when 'owner' then true
    else coalesce((
      select case when write then p.can_write else p.can_read end
      from public.role_permissions p
      where p.role = private.my_role() and p.area = can.area
    ), false)
  end
$$;
revoke execute on function private.can(text, boolean) from public, anon;
grant execute on function private.can(text, boolean) to authenticated;

alter table public.role_permissions enable row level security;
create policy "members read permissions" on public.role_permissions
  for select to authenticated using ((select private.my_role()) is not null);
create policy "owner edits permissions" on public.role_permissions
  for update to authenticated
  using ((select private.my_role()) = 'owner')
  with check ((select private.my_role()) = 'owner');

-- ── 수집 데이터: 키 앞부분(prices/…, land/…, policy/…)이 영역 ──
drop policy "owner reads datasets" on public.datasets;
create policy "read datasets by permission" on public.datasets
  for select to authenticated using ((select private.can(split_part(key, '/', 1))));

-- ── 법정 검사 ──
drop policy "read inspections" on public.inspections;
drop policy "owner writes inspections" on public.inspections;
create policy "read inspections" on public.inspections
  for select to authenticated using ((select private.can('inspections')));
create policy "insert inspections" on public.inspections
  for insert to authenticated with check ((select private.can('inspections', true)));
create policy "update inspections" on public.inspections
  for update to authenticated
  using ((select private.can('inspections', true)))
  with check ((select private.can('inspections', true)));
create policy "delete inspections" on public.inspections
  for delete to authenticated using ((select private.can('inspections', true)));

drop policy "read results" on public.inspection_results;
drop policy "add results" on public.inspection_results;
drop policy "owner edits results" on public.inspection_results;
drop policy "owner or author deletes results" on public.inspection_results;
create policy "read results" on public.inspection_results
  for select to authenticated using ((select private.can('inspections')));
-- 보기 권한만 있어도 결과지는 올릴 수 있음 (검사를 받는 쪽이 올리는 게 기본)
create policy "add results" on public.inspection_results
  for insert to authenticated
  with check ((select private.can('inspections')) and created_by = (select auth.uid()));
create policy "update results" on public.inspection_results
  for update to authenticated
  using ((select private.can('inspections', true)))
  with check ((select private.can('inspections', true)));
create policy "delete results" on public.inspection_results
  for delete to authenticated
  using ((select private.can('inspections', true)) or created_by = (select auth.uid()));

drop policy "read inspection files" on storage.objects;
drop policy "upload inspection files" on storage.objects;
drop policy "owner deletes inspection files" on storage.objects;
create policy "read inspection files" on storage.objects
  for select to authenticated using (bucket_id = 'inspection-files' and (select private.can('inspections')));
create policy "upload inspection files" on storage.objects
  for insert to authenticated with check (bucket_id = 'inspection-files' and (select private.can('inspections')));
create policy "delete inspection files" on storage.objects
  for delete to authenticated using (bucket_id = 'inspection-files' and (select private.can('inspections', true)));

-- ── 계약 일정 ──
drop policy "owner manages contracts" on public.contracts;
drop policy "owner manages contract events" on public.contract_events;
drop policy "owner manages calendar feeds" on public.calendar_feeds;

create policy "read contracts" on public.contracts
  for select to authenticated using ((select private.can('contracts')));
create policy "insert contracts" on public.contracts
  for insert to authenticated with check ((select private.can('contracts', true)));
create policy "update contracts" on public.contracts
  for update to authenticated
  using ((select private.can('contracts', true)))
  with check ((select private.can('contracts', true)));
create policy "delete contracts" on public.contracts
  for delete to authenticated using ((select private.can('contracts', true)));

create policy "read contract events" on public.contract_events
  for select to authenticated using ((select private.can('contracts')));
create policy "insert contract events" on public.contract_events
  for insert to authenticated with check ((select private.can('contracts', true)));
create policy "update contract events" on public.contract_events
  for update to authenticated
  using ((select private.can('contracts', true)))
  with check ((select private.can('contracts', true)));
create policy "delete contract events" on public.contract_events
  for delete to authenticated using ((select private.can('contracts', true)));

-- 캘린더 구독 주소는 계약 수정 권한이 있는 사람이 관리
create policy "manage calendar feeds" on public.calendar_feeds
  for all to authenticated
  using ((select private.can('contracts', true)))
  with check ((select private.can('contracts', true)));

drop policy "owner reads contract files" on storage.objects;
drop policy "owner uploads contract files" on storage.objects;
drop policy "owner deletes contract files" on storage.objects;
create policy "read contract files" on storage.objects
  for select to authenticated using (bucket_id = 'contract-files' and (select private.can('contracts')));
create policy "upload contract files" on storage.objects
  for insert to authenticated with check (bucket_id = 'contract-files' and (select private.can('contracts', true)));
create policy "delete contract files" on storage.objects
  for delete to authenticated using (bucket_id = 'contract-files' and (select private.can('contracts', true)));
