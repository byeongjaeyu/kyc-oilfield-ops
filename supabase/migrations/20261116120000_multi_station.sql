-- 여러 주유소(멀티 테넌트)로 전환
--  - 사이트 관리자(개발자): 주유소 등록 신청 승인, 의견·버그 확인. 주유소 데이터는 볼 수 없음 (회원인 주유소만)
--  - 주유소: 누구나 가입 후 등록 신청 (사업자등록증 사진) → 사이트 관리자 승인 → 신청자가 그 주유소의 관리자
--  - 주유소 관리자: 임대인·임차인 초대, 권한 표, 관리자 넘기기
--  - 모든 데이터는 station_id 로 나뉘고, 회원인 주유소의 데이터만 보임 (RLS)
--  - 기존 데이터는 데모 주유소로 이동, 첫 주유소는 빈 상태로 시작
--  - 기본 계정(사이트 관리자, 첫 주유소 관리자)은 공개 저장소에 이메일을 남기지 않으려고 DB 에서 직접 지정

-- ════════════════════════════════════════════════════════════════
-- 0. 옛 권한 정책·함수 정리
-- ════════════════════════════════════════════════════════════════
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
     where (schemaname = 'public' and tablename in (
              'profiles', 'member_invites', 'datasets', 'inspections', 'inspection_results', 'contracts',
              'contract_events', 'calendar_feeds', 'role_permissions', 'rent_charges', 'bank_transactions', 'bank_webhooks'))
        or (schemaname = 'storage' and tablename = 'objects' and policyname in (
              'read inspection files', 'upload inspection files', 'delete inspection files',
              'read contract files', 'upload contract files', 'delete contract files'))
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

drop trigger if exists guard_new_user on auth.users;
drop function if exists public.guard_new_user();
drop function if exists private.can(text, boolean);
drop function if exists private.can_see_inspection(uuid);
drop function if exists private.can_see_inspection_folder(text);
drop function if exists private.my_role();
drop table public.role_permissions;
drop table public.member_invites;
alter table public.profiles drop column role;
alter table public.profiles add column is_site_admin boolean not null default false;

-- ════════════════════════════════════════════════════════════════
-- 1. 주유소·회원
-- ════════════════════════════════════════════════════════════════
create table public.stations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  address text not null default '',
  jibun_address text not null default '',
  -- 오피넷 (가격 비교)
  opinet_id text,
  brand text not null default '',
  katec_x double precision,
  katec_y double precision,
  -- 국토부 실거래가 (부지 가치): 법정동코드 앞 5자리, 우리 법정동, 주변으로 볼 법정동, 개발 뉴스 검색어
  lawd_cd text check (lawd_cd ~ '^\d{5}$'),
  dong text not null default '',
  nearby_dongs text[] not null default '{}',
  land_keywords text[] not null default '{}',
  -- 등록 신청
  biz_no text not null default '' check (biz_no ~ '^(\d{10})?$'),
  biz_doc_path text,
  biz_doc_name text,
  applicant_role text not null default 'tenant' check (applicant_role in ('owner', 'tenant')),
  applied_by uuid default auth.uid() references auth.users (id) on delete set null,
  applicant_email text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended')),
  review_note text not null default '',
  reviewed_at timestamptz,
  is_demo boolean not null default false,
  -- 기한·미납·가격 알림을 받을 텔레그램 채팅
  telegram_chat_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stations_applied_by_idx on public.stations (applied_by);
-- 같은 주유소를 두 번 등록하지 못하게 (데모 제외)
create unique index stations_opinet_unique on public.stations (opinet_id)
  where opinet_id is not null and not is_demo and status in ('pending', 'approved');
create trigger touch_stations before update on public.stations
  for each row execute function public.touch_updated_at();

create table public.station_members (
  station_id uuid not null references public.stations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'tenant')),
  is_manager boolean not null default false,
  created_at timestamptz not null default now(),
  -- 한 사람이 같은 주유소에서 임대인·임차인 둘 다일 수 있음 (데모에서 개발자가 양쪽 화면 확인)
  primary key (station_id, user_id, role)
);
create index station_members_user_id_idx on public.station_members (user_id);

create table public.station_invites (
  station_id uuid not null references public.stations (id) on delete cascade,
  email text not null check (email = lower(email) and email like '%@%'),
  role text not null check (role in ('owner', 'tenant')),
  is_manager boolean not null default false,
  invited_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (station_id, email, role)
);
create index station_invites_email_idx on public.station_invites (email);
create index station_invites_invited_by_idx on public.station_invites (invited_by);

create table public.station_permissions (
  station_id uuid not null references public.stations (id) on delete cascade,
  role text not null check (role in ('owner', 'tenant')),
  area text not null check (area in ('prices', 'land', 'policy', 'contracts', 'inspections', 'payments')),
  can_read boolean not null default false,
  can_write boolean not null default false,
  primary key (station_id, role, area),
  check (not can_write or can_read)
);

-- 의견·버그 신고 — 보낸 사람과 사이트 관리자만 봄
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  user_email text not null default '',
  station_id uuid references public.stations (id) on delete set null,
  kind text not null default 'bug' check (kind in ('bug', 'idea', 'etc')),
  body text not null check (length(body) between 1 and 5000),
  page text not null default '',
  user_agent text not null default '',
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'wontfix')),
  reply text not null default '',
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index feedback_user_id_idx on public.feedback (user_id);
create index feedback_station_id_idx on public.feedback (station_id);
create trigger touch_feedback before update on public.feedback
  for each row execute function public.touch_updated_at();

-- 보낸 사람·이메일은 서버에서 채움, 답변 칸은 사이트 관리자만
create function public.guard_feedback() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.user_email := coalesce((select email from public.profiles where id = auth.uid()), '');
    new.status := 'new';
    new.reply := '';
    new.replied_at := null;
  else
    new.user_id := old.user_id;
    new.user_email := old.user_email;
    new.body := old.body;
    new.station_id := old.station_id;
    if new.reply is distinct from old.reply then
      new.replied_at := now();
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_feedback() from public, anon, authenticated;
create trigger guard_feedback before insert or update on public.feedback
  for each row execute function public.guard_feedback();

-- ════════════════════════════════════════════════════════════════
-- 2. 권한 헬퍼 (private 스키마, API 로 노출 안 됨)
-- ════════════════════════════════════════════════════════════════
create function private.is_site_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select is_site_admin from public.profiles where id = auth.uid()), false) $$;

-- 승인된 주유소의 회원인지
create function private.is_member(sid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members m join public.stations s on s.id = m.station_id
     where m.station_id = sid and m.user_id = auth.uid() and s.status = 'approved')
$$;

create function private.is_manager(sid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members m join public.stations s on s.id = m.station_id
     where m.station_id = sid and m.user_id = auth.uid() and m.is_manager and s.status = 'approved')
$$;

-- 영역 권한: 관리자는 전부 (잠김 방지), 그 외에는 역할별 권한 표 (역할이 둘이면 합집합)
create function private.can(sid uuid, area text, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members m join public.stations s on s.id = m.station_id
     where m.station_id = sid and m.user_id = auth.uid() and s.status = 'approved'
       and (m.is_manager or exists (
         select 1 from public.station_permissions p
          where p.station_id = m.station_id and p.role = m.role and p.area = can.area
            and case when write then p.can_write else p.can_read end)))
$$;

-- 문자열 id 판 (스토리지 폴더·datasets 키) — 잘못된 uuid 문자열에도 오류 없이 false
create function private.can_text(sid text, area text, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when sid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then private.can(sid::uuid, area, write) else false end
$$;

-- 어느 주유소에서든 그 영역을 볼 수 있는지 (공통 데이터: 업계 정책 리포트)
create function private.can_any(area text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.station_members m where m.user_id = auth.uid() and private.can(m.station_id, area))
$$;

-- 같은 주유소 회원끼리는 이름·이메일을 봄
create function private.shares_station(uid uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.station_members a join public.station_members b on a.station_id = b.station_id
     where a.user_id = auth.uid() and b.user_id = uid)
$$;

-- 등록 신청자 본인인지 (사업자등록증 파일 권한)
create function private.is_applicant_text(sid text, editable boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.stations s
     where s.id::text = sid and s.applied_by = auth.uid()
       and (not editable or s.status in ('pending', 'rejected')))
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- 화면용: 내 권한 (주유소별·역할별) — 본인 것만 돌려줌
create function public.my_permissions(sid uuid)
returns table (role text, is_manager boolean, area text, can_read boolean, can_write boolean)
language sql stable security definer set search_path = ''
as $$
  select m.role, m.is_manager, a.area,
         m.is_manager or coalesce(p.can_read, false),
         m.is_manager or coalesce(p.can_write, false)
    from public.station_members m
    join public.stations s on s.id = m.station_id and s.status = 'approved'
    cross join unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments']) a(area)
    left join public.station_permissions p on p.station_id = m.station_id and p.role = m.role and p.area = a.area
   where m.station_id = sid and m.user_id = auth.uid()
$$;
revoke execute on function public.my_permissions(uuid) from public, anon;
grant execute on function public.my_permissions(uuid) to authenticated;

-- 같은 오피넷 주유소가 이미 등록(또는 신청)됐는지 — 신청 화면 안내용, 주유소 정보는 주지 않음
create function public.station_taken(oid text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.stations where opinet_id = oid and not is_demo and status in ('pending', 'approved'))
$$;
revoke execute on function public.station_taken(text) from public, anon;
grant execute on function public.station_taken(text) to authenticated;

-- 사이트 관리자용 개요: 주유소별 회원 수만 (회원 이름·데이터는 주지 않음)
create function public.admin_station_overview()
returns table (station_id uuid, members int, managers int)
language sql stable security definer set search_path = ''
as $$
  select m.station_id, count(distinct m.user_id)::int, (count(distinct m.user_id) filter (where m.is_manager))::int
    from public.station_members m
   where private.is_site_admin()
   group by m.station_id
$$;
revoke execute on function public.admin_station_overview() from public, anon;
grant execute on function public.admin_station_overview() to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 3. 가입·초대·승인 흐름
-- ════════════════════════════════════════════════════════════════
-- 가입: 누구나 (주유소 데이터는 회원이 돼야 보임). 받아 둔 초대는 바로 회원으로
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, lower(new.email)) on conflict (id) do nothing;
  insert into public.station_members (station_id, user_id, role, is_manager)
  select i.station_id, new.id, i.role, i.is_manager from public.station_invites i where i.email = lower(new.email)
  on conflict do nothing;
  delete from public.station_invites where email = lower(new.email);
  return new;
end $$;

-- 이미 가입한 사람을 초대하면 바로 회원으로
create function public.accept_invite_if_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare uid uuid;
begin
  select id into uid from public.profiles where email = new.email;
  if uid is not null then
    insert into public.station_members (station_id, user_id, role, is_manager)
    values (new.station_id, uid, new.role, new.is_manager)
    on conflict (station_id, user_id, role) do update set is_manager = public.station_members.is_manager or excluded.is_manager;
    delete from public.station_invites where station_id = new.station_id and email = new.email and role = new.role;
  end if;
  return null;
end $$;
create trigger station_invites_accept after insert on public.station_invites
  for each row execute function public.accept_invite_if_user();

-- 주유소 기본값: 권한 표 + 법정 검사 기본 항목
create function private.seed_station(sid uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.station_permissions (station_id, role, area, can_read, can_write)
  select sid, r, a, true, not (r = 'tenant' and a = 'payments')
    from unnest(array['owner', 'tenant']) r,
         unnest(array['prices', 'land', 'policy', 'contracts', 'inspections', 'payments']) a
  on conflict do nothing;
  if not exists (select 1 from public.inspections i where i.station_id = sid) then
    insert into public.inspections (station_id, name, party)
    values (sid, '토양오염도 검사', '임차인'), (sid, '저장탱크 누출검사', '임차인'), (sid, '위험물 정기점검', '임차인'),
           (sid, '소방시설 자체점검', '임차인'), (sid, '화재보험 만기', ''), (sid, '환경책임보험 만기', '');
  end if;
end $$;
revoke execute on function private.seed_station(uuid) from public, anon, authenticated;

-- 신청서 지킴이: 상태·심사 칸은 사이트 관리자만, 신청자는 반려된 신청을 다시 낼 수만 있음
create function public.guard_station() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not private.is_site_admin() then
      new.status := 'pending';
      new.is_demo := false;
      new.applied_by := auth.uid();
      new.review_note := '';
      new.reviewed_at := null;
    end if;
    if new.applicant_email = '' and new.applied_by is not null then
      new.applicant_email := coalesce((select email from public.profiles where id = new.applied_by), '');
    end if;
    return new;
  end if;

  if auth.uid() is not null and not private.is_site_admin() then
    if new.status is distinct from old.status
       and not (old.status = 'rejected' and new.status = 'pending' and old.applied_by = auth.uid()) then
      raise exception 'status_locked' using errcode = 'P0001';
    end if;
    new.review_note := old.review_note;
    new.reviewed_at := old.reviewed_at;
    new.is_demo := old.is_demo;
    new.applied_by := old.applied_by;
    new.applicant_email := old.applicant_email;
    new.applicant_role := case when old.status in ('pending', 'rejected') then new.applicant_role else old.applicant_role end;
  elsif new.status is distinct from old.status then
    new.reviewed_at := now();
  end if;
  return new;
end $$;
create trigger guard_station before insert or update on public.stations
  for each row execute function public.guard_station();

-- 승인되면 신청자를 관리자로 넣고 기본값을 채움
create function public.on_station_approved() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform private.seed_station(new.id);
    if new.applied_by is not null then
      insert into public.station_members (station_id, user_id, role, is_manager)
      values (new.id, new.applied_by, new.applicant_role, true)
      on conflict (station_id, user_id, role) do update set is_manager = true;
    end if;
  end if;
  return null;
end $$;
create trigger station_approved after insert or update of status on public.stations
  for each row execute function public.on_station_approved();

-- 관리자가 한 명도 없게 만들 수는 없음 (주유소를 통째로 지우는 경우는 제외)
create function public.keep_a_manager() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare sid uuid := coalesce(old.station_id, new.station_id);
begin
  if exists (select 1 from public.stations where id = sid)
     and exists (select 1 from public.station_members where station_id = sid)
     and not exists (select 1 from public.station_members where station_id = sid and is_manager) then
    raise exception '주유소에는 관리자가 한 명 이상 있어야 합니다. 다른 회원을 먼저 관리자로 지정하세요.'
      using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger keep_a_manager after update or delete on public.station_members
  deferrable initially deferred
  for each row execute function public.keep_a_manager();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.accept_invite_if_user() from public, anon, authenticated;
revoke execute on function public.guard_station() from public, anon, authenticated;
revoke execute on function public.on_station_approved() from public, anon, authenticated;
revoke execute on function public.keep_a_manager() from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════
-- 4. 기본 주유소 두 곳 (첫 주유소, 데모) — 실제 값은 운영 DB 에서 정함, 여기는 예시 값
-- ════════════════════════════════════════════════════════════════
--  station_id 컬럼을 붙이기 전이라 승인 트리거의 기본값 채우기는 잠시 끄고 넣음
alter table public.stations disable trigger station_approved;
insert into public.stations (id, name, address, opinet_id, brand, katec_x, katec_y,
                             lawd_cd, dong, nearby_dongs, land_keywords, applicant_role, status, is_demo, review_note)
values
  ('00000000-0000-4000-8000-000000000001', '예시 주유소', '예시시 예시구 예시로 1', null, '',
   null, null, null, '', array[]::text[], array[]::text[],
   'tenant', 'approved', false, '최초 주유소 (기본 등록)'),
  ('de300000-0000-4000-8000-000000000001', '데모 주유소', '데모용', null, '',
   null, null, null, '', array[]::text[], array[]::text[],
   'owner', 'approved', true, '버그 재현·기능 개발용 데모');
alter table public.stations enable trigger station_approved;

-- ════════════════════════════════════════════════════════════════
-- 5. 데이터 테이블에 station_id — 기존 데이터는 데모 주유소로
-- ════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['inspections', 'inspection_results', 'contracts', 'contract_events', 'calendar_feeds',
                           'rent_charges', 'bank_transactions', 'bank_webhooks']
  loop
    execute format('alter table public.%I add column station_id uuid references public.stations (id) on delete cascade', t);
    execute format('update public.%I set station_id = %L', t, 'de300000-0000-4000-8000-000000000001');
    execute format('alter table public.%I alter column station_id set not null', t);
    execute format('create index %I on public.%I (station_id)', t || '_station_id_idx', t);
  end loop;
end $$;

-- 상위 행에서 station_id 를 받아 오는 하위 테이블 (결과지·계약 일정·월별 청구)
create function public.inherit_station_id() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'inspection_results' then
    select station_id into new.station_id from public.inspections where id = new.inspection_id;
  else
    select station_id into new.station_id from public.contracts where id = new.contract_id;
  end if;
  return new;
end $$;
revoke execute on function public.inherit_station_id() from public, anon, authenticated;
create trigger inherit_station before insert or update of inspection_id on public.inspection_results
  for each row execute function public.inherit_station_id();
create trigger inherit_station before insert or update of contract_id on public.contract_events
  for each row execute function public.inherit_station_id();
create trigger inherit_station before insert or update of contract_id on public.rent_charges
  for each row execute function public.inherit_station_id();

-- 입금 중복 판정은 주유소 안에서만
alter table public.bank_transactions drop constraint bank_transactions_dedupe_key_key;
alter table public.bank_transactions add constraint bank_transactions_station_dedupe unique (station_id, dedupe_key);

-- 입금 자동 매칭: 같은 주유소의 계약만
create or replace function public.match_bank_transaction() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  cid uuid;
  target uuid;
  payer_norm text := public.normalize_payer(new.payer);
begin
  if new.charge_id is not null then
    return new;
  end if;

  select c.id into cid
    from public.contracts c
   where c.station_id = new.station_id
     and c.status = 'confirmed'
     and exists (
       select 1 from unnest(c.payer_names || array[c.tenant_name]) n
        where length(public.normalize_payer(n)) >= 2
          and (payer_norm like '%' || public.normalize_payer(n) || '%'
               or public.normalize_payer(n) like '%' || payer_norm || '%' and length(payer_norm) >= 2)
     )
   order by c.end_date desc nulls last
   limit 1;
  if cid is null then
    return new;
  end if;

  select rc.id into target
    from public.rent_charges rc
   where rc.contract_id = cid
     and rc.due_date between (new.occurred_at at time zone 'Asia/Seoul')::date - 75
                         and (new.occurred_at at time zone 'Asia/Seoul')::date + 45
     and rc.expected_amount > coalesce((select sum(t.amount) from public.bank_transactions t where t.charge_id = rc.id), 0)
   order by rc.due_date
   limit 1;

  new.charge_id := target;
  return new;
end $$;

-- 다른 주유소의 청구에 입금을 잇지 못하게 (트리거 이름순: bank_transactions_match → check_charge_station)
create function public.check_charge_station() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.charge_id is not null
     and not exists (select 1 from public.rent_charges where id = new.charge_id and station_id = new.station_id) then
    raise exception 'charge_station_mismatch' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.check_charge_station() from public, anon, authenticated;
create trigger check_charge_station before insert or update of charge_id, station_id on public.bank_transactions
  for each row execute function public.check_charge_station();

-- 납부 현황 뷰에 station_id 포함
drop view public.rent_charge_status;
create view public.rent_charge_status with (security_invoker = true) as
select
  rc.id, rc.contract_id, rc.station_id, rc.period, rc.due_date, rc.expected_amount, rc.manual, rc.note, rc.created_at,
  c.title as contract_title,
  coalesce(p.paid, 0)::bigint as paid_amount,
  coalesce(p.n, 0)::int as payment_count,
  p.last_paid_at,
  case
    when coalesce(p.paid, 0) >= rc.expected_amount and coalesce(p.paid, 0) > rc.expected_amount + 1000 then '초과'
    when coalesce(p.paid, 0) >= rc.expected_amount then '완납'
    when coalesce(p.paid, 0) > 0 then '부분'
    when rc.due_date < (now() at time zone 'Asia/Seoul')::date then '미납'
    else '예정'
  end as status
from public.rent_charges rc
join public.contracts c on c.id = rc.contract_id
left join lateral (
  select sum(t.amount) as paid, count(*) as n, max(t.occurred_at) as last_paid_at
  from public.bank_transactions t where t.charge_id = rc.id
) p on true;

-- 권한 표 + 법정 검사 기본 항목 (데모는 기존 항목이 있어 권한 표만)
select private.seed_station('00000000-0000-4000-8000-000000000001');
select private.seed_station('de300000-0000-4000-8000-000000000001');

-- 수집 데이터: 가격·부지는 주유소별 키(st/<id>/…)로. 데모는 첫 주유소 위치 데이터를 복사
insert into public.datasets (key, data, updated_at)
select 'st/' || s.id || '/' || d.key, d.data, d.updated_at
  from public.datasets d
 cross join (values ('00000000-0000-4000-8000-000000000001'::uuid), ('de300000-0000-4000-8000-000000000001'::uuid)) s(id)
 where d.key ~ '^(prices|land)/' and d.key not in ('prices/usage.json', 'prices/station.json')
on conflict (key) do nothing;
update public.datasets set key = 'sys/opinet-usage.json' where key = 'prices/usage.json';
delete from public.datasets where key ~ '^(prices|land)/';

-- ════════════════════════════════════════════════════════════════
-- 6. RLS
-- ════════════════════════════════════════════════════════════════
alter table public.stations enable row level security;
alter table public.station_members enable row level security;
alter table public.station_invites enable row level security;
alter table public.station_permissions enable row level security;
alter table public.feedback enable row level security;

-- 프로필: 본인 + 같은 주유소 회원. 본인은 이름만 고침
create policy "read profiles" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select private.shares_station(id)));
create policy "edit own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;

-- 주유소: 회원·신청자·사이트 관리자가 봄
create policy "read stations" on public.stations
  for select to authenticated
  using ((select private.is_member(id)) or applied_by = (select auth.uid()) or (select private.is_site_admin()));
create policy "apply station" on public.stations
  for insert to authenticated with check (applied_by = (select auth.uid()));
create policy "update stations" on public.stations
  for update to authenticated
  using ((select private.is_site_admin()) or (select private.is_manager(id))
         or (applied_by = (select auth.uid()) and status in ('pending', 'rejected')))
  with check ((select private.is_site_admin()) or (select private.is_manager(id))
              or (applied_by = (select auth.uid()) and status in ('pending', 'rejected')));
create policy "delete stations" on public.stations
  for delete to authenticated
  using ((select private.is_site_admin()) or (applied_by = (select auth.uid()) and status in ('pending', 'rejected')));

create policy "read members" on public.station_members
  for select to authenticated using ((select private.is_member(station_id)));
create policy "add members" on public.station_members
  for insert to authenticated with check ((select private.is_manager(station_id)));
create policy "update members" on public.station_members
  for update to authenticated
  using ((select private.is_manager(station_id))) with check ((select private.is_manager(station_id)));
create policy "remove members" on public.station_members
  for delete to authenticated using ((select private.is_manager(station_id)) or user_id = (select auth.uid()));

create policy "manage invites" on public.station_invites
  for all to authenticated
  using ((select private.is_manager(station_id))) with check ((select private.is_manager(station_id)));

create policy "read permissions" on public.station_permissions
  for select to authenticated using ((select private.is_member(station_id)));
create policy "edit permissions" on public.station_permissions
  for update to authenticated
  using ((select private.is_manager(station_id))) with check ((select private.is_manager(station_id)));

create policy "read feedback" on public.feedback
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_site_admin()));
create policy "send feedback" on public.feedback
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (station_id is null or (select private.is_member(station_id))));
create policy "answer feedback" on public.feedback
  for update to authenticated
  using ((select private.is_site_admin())) with check ((select private.is_site_admin()));

-- 수집 데이터: policy/… 는 공통, st/<주유소>/<영역>/… 는 그 주유소 권한, 나머지(sys/…)는 잡 전용
create policy "read datasets" on public.datasets
  for select to authenticated
  using (case split_part(key, '/', 1)
           when 'policy' then (select private.can_any('policy'))
           when 'st' then private.can_text(split_part(key, '/', 2), split_part(key, '/', 3))
           else false end);

-- 법정 검사
create policy "read inspections" on public.inspections
  for select to authenticated using ((select private.can(station_id, 'inspections')));
create policy "insert inspections" on public.inspections
  for insert to authenticated with check ((select private.can(station_id, 'inspections', true)));
create policy "update inspections" on public.inspections
  for update to authenticated
  using ((select private.can(station_id, 'inspections', true)))
  with check ((select private.can(station_id, 'inspections', true)));
create policy "delete inspections" on public.inspections
  for delete to authenticated using ((select private.can(station_id, 'inspections', true)));

create policy "read results" on public.inspection_results
  for select to authenticated using ((select private.can(station_id, 'inspections')));
-- 보기 권한만 있어도 결과지는 올릴 수 있음 (검사를 받는 쪽이 올리는 게 기본)
create policy "add results" on public.inspection_results
  for insert to authenticated
  with check ((select private.can(station_id, 'inspections')) and created_by = (select auth.uid()));
create policy "update results" on public.inspection_results
  for update to authenticated
  using ((select private.can(station_id, 'inspections', true)))
  with check ((select private.can(station_id, 'inspections', true)));
create policy "delete results" on public.inspection_results
  for delete to authenticated
  using ((select private.can(station_id, 'inspections', true))
         or (created_by = (select auth.uid()) and (select private.can(station_id, 'inspections'))));

-- 계약
create policy "read contracts" on public.contracts
  for select to authenticated using ((select private.can(station_id, 'contracts')));
create policy "insert contracts" on public.contracts
  for insert to authenticated with check ((select private.can(station_id, 'contracts', true)));
create policy "update contracts" on public.contracts
  for update to authenticated
  using ((select private.can(station_id, 'contracts', true)))
  with check ((select private.can(station_id, 'contracts', true)));
create policy "delete contracts" on public.contracts
  for delete to authenticated using ((select private.can(station_id, 'contracts', true)));

create policy "read contract events" on public.contract_events
  for select to authenticated using ((select private.can(station_id, 'contracts')));
create policy "insert contract events" on public.contract_events
  for insert to authenticated with check ((select private.can(station_id, 'contracts', true)));
create policy "update contract events" on public.contract_events
  for update to authenticated
  using ((select private.can(station_id, 'contracts', true)))
  with check ((select private.can(station_id, 'contracts', true)));
create policy "delete contract events" on public.contract_events
  for delete to authenticated using ((select private.can(station_id, 'contracts', true)));

create policy "manage calendar feeds" on public.calendar_feeds
  for all to authenticated
  using ((select private.can(station_id, 'contracts', true)))
  with check ((select private.can(station_id, 'contracts', true)));

-- 입금
create policy "read charges" on public.rent_charges
  for select to authenticated using ((select private.can(station_id, 'payments')));
create policy "write charges" on public.rent_charges
  for update to authenticated
  using ((select private.can(station_id, 'payments', true)))
  with check ((select private.can(station_id, 'payments', true)));

create policy "read transactions" on public.bank_transactions
  for select to authenticated using ((select private.can(station_id, 'payments')));
create policy "insert transactions" on public.bank_transactions
  for insert to authenticated with check ((select private.can(station_id, 'payments', true)));
create policy "update transactions" on public.bank_transactions
  for update to authenticated
  using ((select private.can(station_id, 'payments', true)))
  with check ((select private.can(station_id, 'payments', true)));
create policy "delete transactions" on public.bank_transactions
  for delete to authenticated using ((select private.can(station_id, 'payments', true)));

create policy "manage bank webhooks" on public.bank_webhooks
  for all to authenticated
  using ((select private.can(station_id, 'payments', true)))
  with check ((select private.can(station_id, 'payments', true)));

-- ════════════════════════════════════════════════════════════════
-- 7. 파일 — 새 파일은 <주유소 id>/… 경로. 옛 경로 파일은 DB 행으로 주유소를 찾음
-- ════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('biz-docs', 'biz-docs', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

create function private.can_file(bucket text, path text, write boolean default false) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case bucket
    when 'inspection-files' then
      private.can_text((storage.foldername(path))[1], 'inspections', write)
      or exists (select 1 from public.inspection_results r where r.file_path = path and private.can(r.station_id, 'inspections', write))
    when 'contract-files' then
      private.can_text((storage.foldername(path))[1], 'contracts', write)
      or exists (select 1 from public.contracts c where c.file_path = path and private.can(c.station_id, 'contracts', write))
    when 'biz-docs' then
      private.is_applicant_text((storage.foldername(path))[1], write)
      or (not write and private.is_site_admin())
    else false
  end
$$;
revoke execute on function private.can_file(text, text, boolean) from public, anon;
grant execute on function private.can_file(text, text, boolean) to authenticated;

create policy "read station files" on storage.objects
  for select to authenticated
  using (bucket_id in ('inspection-files', 'contract-files', 'biz-docs') and private.can_file(bucket_id, name));
-- 결과지는 보기 권한으로 올림, 계약서는 수정 권한, 사업자등록증은 신청자 본인
create policy "upload station files" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('inspection-files', 'contract-files', 'biz-docs')
              and private.can_file(bucket_id, name, bucket_id <> 'inspection-files'));
create policy "delete station files" on storage.objects
  for delete to authenticated
  using (bucket_id in ('inspection-files', 'contract-files', 'biz-docs') and private.can_file(bucket_id, name, true));
