-- 공개 전 보완
--  1) 남용 방지: 서버 함수(오피넷 검색·바코드 AI·계약서 AI) 하루 사용 한도, 의견·등록 신청 횟수 제한
--  2) 개인정보처리방침에 쓸 운영자 연락처 (저장소가 아니라 DB에)

-- ── 1. 서버 함수 사용 횟수 (API 로는 안 보이는 private 스키마) ──
create table private.usage_counts (
  user_id uuid not null,
  fn text not null,
  day date not null default (now() at time zone 'Asia/Seoul')::date,
  n int not null default 0,
  primary key (user_id, fn, day)
);

/** 한 번 쓰고 한도 안이면 true. 전체 한도는 user_id 0 줄에 셈. 서비스 키(서버 함수)만 부름 */
create function public.bump_usage(uid uuid, fn text, per_user int, total int) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  mine int;
  everyone int;
begin
  insert into private.usage_counts (user_id, fn, day, n) values (uid, fn, today, 1)
    on conflict (user_id, fn, day) do update set n = private.usage_counts.n + 1
    returning n into mine;
  insert into private.usage_counts (user_id, fn, day, n) values ('00000000-0000-0000-0000-000000000000', fn, today, 1)
    on conflict (user_id, fn, day) do update set n = private.usage_counts.n + 1
    returning n into everyone;
  return mine <= per_user and everyone <= total;
end $$;
revoke execute on function public.bump_usage(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, text, int, int) to service_role;

-- ── 의견·버그: 한 사람 하루 20건 ──
create function public.limit_feedback() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.feedback where user_id = new.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception '오늘은 의견을 너무 많이 보냈습니다. 내일 다시 보내 주세요.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.limit_feedback() from public, anon, authenticated;
create trigger limit_feedback before insert on public.feedback
  for each row execute function public.limit_feedback();

-- ── 등록 신청: 심사 대기 3건, 하루 5건까지 (사이트 관리자는 제외) ──
create function public.limit_applications() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select private.is_site_admin()) then
    return new;
  end if;
  if (select count(*) from public.stations where applied_by = new.applied_by and status = 'pending') >= 3 then
    raise exception '심사를 기다리는 신청이 이미 3건 있습니다. 결과가 나온 뒤 다시 신청해 주세요.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.stations where applied_by = new.applied_by and created_at > now() - interval '1 day') >= 5 then
    raise exception '오늘은 신청을 너무 많이 했습니다. 내일 다시 해 주세요.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.limit_applications() from public, anon, authenticated;
create trigger limit_applications before insert on public.stations
  for each row execute function public.limit_applications();

-- ── 2. 운영자 연락처 ──
alter table public.site_config
  add column contact_email text not null default ''
    check (contact_email = '' or (contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(contact_email) <= 200));
