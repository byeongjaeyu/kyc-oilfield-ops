-- 사이트 관리자: 모든 주유소의 가입자·가입 대기·메일 발송 기록
--  메일 기록은 auth.users 의 *_sent_at 이 바뀌는 순간(= Supabase 가 메일을 보낸 순간)을 남김
--  보내기 전에 거절된 요청(발송 한도 초과 등)과 받은편지함 도착 여부는 여기 남지 않음

create table public.auth_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  email text not null default '',
  kind text not null check (kind in ('login_link', 'signup_confirm', 'invite', 'email_change', 'login')),
  at timestamptz not null default now()
);
create index auth_events_at_idx on public.auth_events (at desc);
create index auth_events_user_idx on public.auth_events (user_id, at desc);
alter table public.auth_events enable row level security;
revoke all on public.auth_events from anon, authenticated;

create function public.log_auth_events() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.recovery_sent_at is not null and new.recovery_sent_at is distinct from (case when tg_op = 'UPDATE' then old.recovery_sent_at end) then
    insert into public.auth_events (user_id, email, kind, at) values (new.id, coalesce(new.email, ''), 'login_link', new.recovery_sent_at);
  end if;
  if new.confirmation_sent_at is not null and new.confirmation_sent_at is distinct from (case when tg_op = 'UPDATE' then old.confirmation_sent_at end) then
    insert into public.auth_events (user_id, email, kind, at) values (new.id, coalesce(new.email, ''), 'signup_confirm', new.confirmation_sent_at);
  end if;
  if new.invited_at is not null and new.invited_at is distinct from (case when tg_op = 'UPDATE' then old.invited_at end) then
    insert into public.auth_events (user_id, email, kind, at) values (new.id, coalesce(new.email, ''), 'invite', new.invited_at);
  end if;
  if new.email_change_sent_at is not null and new.email_change_sent_at is distinct from (case when tg_op = 'UPDATE' then old.email_change_sent_at end) then
    insert into public.auth_events (user_id, email, kind, at) values (new.id, coalesce(new.email_change, new.email, ''), 'email_change', new.email_change_sent_at);
  end if;
  if new.last_sign_in_at is not null and new.last_sign_in_at is distinct from (case when tg_op = 'UPDATE' then old.last_sign_in_at end) then
    insert into public.auth_events (user_id, email, kind, at) values (new.id, coalesce(new.email, ''), 'login', new.last_sign_in_at);
  end if;
  return new;
exception when others then
  return new; -- 기록 실패가 로그인을 막으면 안 됨
end $$;
revoke execute on function public.log_auth_events() from public, anon, authenticated;
create trigger log_auth_events after insert or update on auth.users
  for each row execute function public.log_auth_events();

-- 지금까지 남아 있는 마지막 발송·로그인 시각으로 채워 둠
insert into public.auth_events (user_id, email, kind, at)
select id, coalesce(email, ''), k, t from auth.users,
  lateral (values ('login_link', recovery_sent_at), ('signup_confirm', confirmation_sent_at), ('invite', invited_at), ('login', last_sign_in_at)) v(k, t)
 where t is not null;

-- ── 사이트 관리자 조회 ──
-- 주유소별 가입자
create function public.admin_members()
returns table (
  station_id uuid, station_name text, station_status text, operation text, is_demo boolean,
  user_id uuid, email text, role text, is_manager boolean, joined_at timestamptz,
  last_sign_in_at timestamptz, last_request_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.name, s.status, s.operation, s.is_demo,
         u.id, u.email, m.role, m.is_manager, m.created_at,
         u.last_sign_in_at, (select max(a.last_at) from public.user_activity a where a.user_id = u.id)
    from public.station_members m
    join public.stations s on s.id = m.station_id
    join auth.users u on u.id = m.user_id
   where private.is_site_admin()
   order by s.is_demo, s.name, m.role, m.created_at
$$;

-- 가입 대기: 초대만 받고 아직 로그인 안 함 / 승인 기다리는 신청 / 가입했지만 주유소 없음
create function public.admin_pending()
returns table (kind text, station_id uuid, station_name text, email text, role text, is_manager boolean, since timestamptz, by_email text, note text)
language sql stable security definer set search_path = ''
as $$
  select 'invite', s.id, s.name, i.email, i.role, i.is_manager, i.created_at, coalesce(b.email, ''), ''
    from public.station_invites i join public.stations s on s.id = i.station_id left join auth.users b on b.id = i.invited_by
   where private.is_site_admin()
  union all
  select 'application', s.id, s.name, coalesce(nullif(s.applicant_email, ''), a.email, ''), s.applicant_role, true, s.created_at, '',
         case when s.biz_doc_path is null then '사업자등록증 안 올림' else '' end
    from public.stations s left join auth.users a on a.id = s.applied_by
   where private.is_site_admin() and s.status = 'pending'
  union all
  select 'no_station', null, null, u.email, null, false, u.created_at, '',
         case when u.last_sign_in_at is null then '링크를 아직 안 누름' else '로그인했지만 주유소 없음' end
    from auth.users u
   where private.is_site_admin()
     and not exists (select 1 from public.station_members m where m.user_id = u.id)
     and not exists (select 1 from public.stations s where s.applied_by = u.id and s.status in ('pending', 'rejected'))
     and not coalesce((select p.is_site_admin from public.profiles p where p.id = u.id), false)
  order by 7 desc
$$;

-- 메일 발송 기록 (+ 그 메일 뒤에 로그인했는지)
create function public.admin_mail_log(days int default 30)
returns table (at timestamptz, email text, kind text, logged_in_at timestamptz, stations text)
language sql stable security definer set search_path = ''
as $$
  select e.at, e.email, e.kind,
         (select min(l.at) from public.auth_events l
           where l.user_id = e.user_id and l.kind = 'login' and l.at >= e.at
             and l.at < coalesce((select min(n.at) from public.auth_events n where n.user_id = e.user_id and n.kind <> 'login' and n.at > e.at), 'infinity')),
         (select string_agg(distinct s.name, ', ') from public.station_members m join public.stations s on s.id = m.station_id where m.user_id = e.user_id)
    from public.auth_events e
   where private.is_site_admin() and e.kind <> 'login'
     and e.at > now() - make_interval(days => greatest(1, least(days, 365)))
   order by e.at desc
   limit 500
$$;

revoke execute on function public.admin_members(), public.admin_pending(), public.admin_mail_log(int) from public, anon;
grant execute on function public.admin_members(), public.admin_pending(), public.admin_mail_log(int) to authenticated;
