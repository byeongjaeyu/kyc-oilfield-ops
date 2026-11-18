-- 주유소 운영 대시보드 — 초기 스키마
--  역할: owner(임대인) 전체, tenant(임차인) 임차인 담당 법정 검사만
--  가입: member_invites 에 있는 이메일만 계정을 만들 수 있음 (초대제)

-- ── 회원 ──────────────────────────────────────────────────────────
create table public.member_invites (
  email text primary key check (email = lower(email)),
  role text not null check (role in ('owner', 'tenant')),
  name text not null default '',
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null default '',
  role text check (role in ('owner', 'tenant')),
  created_at timestamptz not null default now()
);

-- 현재 사용자 역할 (RLS 안에서 profiles 재귀를 피하려고 security definer)
create function public.my_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.profiles where id = auth.uid() $$;

-- 초대받지 않은 이메일은 계정 생성 자체를 막음
create function public.guard_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.member_invites where email = lower(new.email)) then
    raise exception 'not_invited' using errcode = 'P0001';
  end if;
  return new;
end $$;

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, role)
  select new.id, lower(new.email), i.name, i.role
  from public.member_invites i where i.email = lower(new.email);
  return new;
end $$;

create trigger guard_new_user before insert on auth.users
  for each row execute function public.guard_new_user();
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.member_invites enable row level security;
alter table public.profiles enable row level security;

create policy "owner manages invites" on public.member_invites
  for all to authenticated
  using ((select public.my_role()) = 'owner')
  with check ((select public.my_role()) = 'owner');

create policy "see own profile, owner sees all" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.my_role()) = 'owner');

create policy "owner edits profiles" on public.profiles
  for update to authenticated
  using ((select public.my_role()) = 'owner')
  with check ((select public.my_role()) = 'owner');

create policy "owner deletes profiles" on public.profiles
  for delete to authenticated
  using ((select public.my_role()) = 'owner');

-- ── 수집 데이터 (가격·부지·정책) — Actions 가 service role 로 씀, 임대인만 읽음 ──
create table public.datasets (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.datasets enable row level security;
create policy "owner reads datasets" on public.datasets
  for select to authenticated
  using ((select public.my_role()) = 'owner');

-- ── 법정 검사 ─────────────────────────────────────────────────────
create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  due date,
  cycle_months int check (cycle_months between 1 and 120),
  party text not null default '' check (party in ('임차인', '임대인', '')),
  agency text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inspection_results (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections (id) on delete cascade,
  done_on date not null,
  verdict text not null default '' check (verdict in ('적합', '부적합', '완료', '')),
  note text not null default '',
  file_path text,
  file_name text,
  file_type text,
  file_size int,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index inspection_results_inspection_id_idx on public.inspection_results (inspection_id);
create index inspection_results_created_by_idx on public.inspection_results (created_by);

-- 임차인이 볼 수 있는 항목인지 (임차인 담당만)
create function public.can_see_inspection(iid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case public.my_role()
    when 'owner' then true
    when 'tenant' then exists (select 1 from public.inspections where id = iid and party = '임차인')
    else false
  end
$$;

-- 스토리지 경로의 첫 폴더(검사 항목 id 문자열)로 확인 — uuid 형변환 오류를 피하려고 text 비교
create function public.can_see_inspection_folder(folder text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case public.my_role()
    when 'owner' then exists (select 1 from public.inspections where id::text = folder)
    when 'tenant' then exists (select 1 from public.inspections where id::text = folder and party = '임차인')
    else false
  end
$$;

-- 결과가 등록되면 주기만큼 다음 기한을 자동으로 미룸 (임차인이 올려도 동작)
create function public.roll_inspection_due() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.inspections i
     set due = (new.done_on + make_interval(months => i.cycle_months))::date,
         updated_at = now()
   where i.id = new.inspection_id
     and i.cycle_months is not null
     and (i.due is null or (new.done_on + make_interval(months => i.cycle_months))::date > i.due);
  return new;
end $$;

create trigger roll_due after insert on public.inspection_results
  for each row execute function public.roll_inspection_due();

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$ begin new.updated_at = now(); return new; end $$;

create trigger touch_inspections before update on public.inspections
  for each row execute function public.touch_updated_at();

alter table public.inspections enable row level security;
alter table public.inspection_results enable row level security;

create policy "read inspections" on public.inspections
  for select to authenticated using ((select public.can_see_inspection(id)));
create policy "owner writes inspections" on public.inspections
  for all to authenticated
  using ((select public.my_role()) = 'owner')
  with check ((select public.my_role()) = 'owner');

create policy "read results" on public.inspection_results
  for select to authenticated using ((select public.can_see_inspection(inspection_id)));
create policy "add results" on public.inspection_results
  for insert to authenticated
  with check ((select public.can_see_inspection(inspection_id)) and created_by = (select auth.uid()));
create policy "owner edits results" on public.inspection_results
  for update to authenticated
  using ((select public.my_role()) = 'owner')
  with check ((select public.my_role()) = 'owner');
create policy "owner or author deletes results" on public.inspection_results
  for delete to authenticated
  using ((select public.my_role()) = 'owner' or created_by = (select auth.uid()));

-- 처음 넣어 두는 항목 (기한·주기는 결과지/통지서 보고 입력)
insert into public.inspections (name, party) values
  ('토양오염도 검사', '임차인'),
  ('저장탱크 누출검사', '임차인'),
  ('위험물 정기점검', '임차인'),
  ('소방시설 자체점검', '임차인'),
  ('화재보험 만기', ''),
  ('환경책임보험 만기', '');

-- ── 결과지 파일 (비공개 버킷) ─────────────────────────────────────
--  경로: <inspection_id>/<임의값>-<파일이름>
insert into storage.buckets (id, name, public, file_size_limit)
values ('inspection-files', 'inspection-files', false, 15728640);

create policy "read inspection files" on storage.objects
  for select to authenticated
  using (bucket_id = 'inspection-files'
         and (select public.can_see_inspection_folder((storage.foldername(name))[1])));
create policy "upload inspection files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'inspection-files'
              and (select public.can_see_inspection_folder((storage.foldername(name))[1])));
create policy "owner deletes inspection files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'inspection-files' and (select public.my_role()) = 'owner');

-- 헬퍼 함수는 로그인한 사용자만 (비로그인 RPC 호출 차단)
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.can_see_inspection(uuid) from public, anon;
revoke execute on function public.can_see_inspection_folder(text) from public, anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.can_see_inspection(uuid) to authenticated;
grant execute on function public.can_see_inspection_folder(text) to authenticated;
revoke execute on function public.guard_new_user() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.roll_inspection_due() from public, anon, authenticated;
