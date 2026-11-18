-- RLS 헬퍼를 API 로 노출되지 않는 private 스키마로 옮김 (rpc 로 직접 호출 불가)
create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.my_role() set schema private;
alter function public.can_see_inspection(uuid) set schema private;
alter function public.can_see_inspection_folder(text) set schema private;

-- 함수 본문이 public.my_role() 을 부르므로 다시 정의
create or replace function private.can_see_inspection(iid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case private.my_role()
    when 'owner' then true
    when 'tenant' then exists (select 1 from public.inspections where id = iid and party = '임차인')
    else false
  end
$$;

create or replace function private.can_see_inspection_folder(folder text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case private.my_role()
    when 'owner' then exists (select 1 from public.inspections where id::text = folder)
    when 'tenant' then exists (select 1 from public.inspections where id::text = folder and party = '임차인')
    else false
  end
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
