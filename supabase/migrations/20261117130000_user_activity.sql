-- 접속 기록 — 사이트 관리자가 "누가 언제 들어왔는지"만 봄 (주유소 데이터·IP·기기 정보 저장 안 함)
--  하루에 한 줄: 그날 처음·마지막 접속, 들어온 횟수(30분 넘게 쉬었다 오면 1회), 마지막에 본 주유소, 휴대폰/PC
create table public.user_activity (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  visits int not null default 1 check (visits > 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  last_station_id uuid references public.stations (id) on delete set null,
  device text not null default 'desktop' check (device in ('mobile', 'desktop')),
  primary key (user_id, day)
);
create index user_activity_day_idx on public.user_activity (day desc);
create index user_activity_station_idx on public.user_activity (last_station_id);

alter table public.user_activity enable row level security;
revoke all on public.user_activity from anon;
create policy "site admin reads activity" on public.user_activity for select to authenticated using ((select private.is_site_admin()));

-- 화면이 열릴 때 호출. 본인 기록만, 소속 주유소만 기록
create function public.touch_activity(sid uuid default null, dev text default 'desktop') returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Seoul')::date;
  st uuid := case when sid is not null and private.is_member(sid) then sid end;
begin
  if uid is null then return; end if;
  insert into public.user_activity (user_id, day, last_station_id, device)
  values (uid, today, st, case when dev = 'mobile' then 'mobile' else 'desktop' end)
  on conflict (user_id, day) do update
    set visits = public.user_activity.visits + case when now() - public.user_activity.last_at > interval '30 minutes' then 1 else 0 end,
        last_at = now(),
        last_station_id = coalesce(excluded.last_station_id, public.user_activity.last_station_id),
        device = excluded.device;
end $$;
revoke execute on function public.touch_activity(uuid, text) from public, anon;
grant execute on function public.touch_activity(uuid, text) to authenticated;

-- 사이트 관리자: 사람별 최근 접속 (소속 주유소 이름과 역할만, 주유소 데이터는 없음)
create function public.admin_recent_activity(days int default 30)
returns table (
  user_id uuid, email text, is_site_admin boolean, signed_up_at timestamptz, last_sign_in_at timestamptz,
  last_at timestamptz, active_days int, visits int, device text, last_station text, stations text
)
language sql stable security definer set search_path = ''
as $$
  select u.id, u.email, coalesce(p.is_site_admin, false), u.created_at, u.last_sign_in_at,
         a.last_at, coalesce(a.active_days, 0), coalesce(a.visits, 0), a.device, a.last_station,
         (select string_agg(s.name || ' ' || case when m.role = 'owner' then case when s.operation = 'self' then '직접 운영' else '임대인' end else '임차인' end
                            || case when m.is_manager then '·관리자' else '' end, ', ' order by s.name)
            from public.station_members m join public.stations s on s.id = m.station_id where m.user_id = u.id)
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join lateral (
      select max(x.last_at) as last_at, count(*)::int as active_days, sum(x.visits)::int as visits,
             (array_agg(x.device order by x.last_at desc))[1] as device,
             (array_agg(s.name order by x.last_at desc) filter (where s.name is not null))[1] as last_station
        from public.user_activity x left join public.stations s on s.id = x.last_station_id
       where x.user_id = u.id and x.day > (now() at time zone 'Asia/Seoul')::date - greatest(1, least(days, 365))
    ) a on true
   where private.is_site_admin()
   order by coalesce(a.last_at, u.last_sign_in_at, u.created_at) desc nulls last
$$;
revoke execute on function public.admin_recent_activity(int) from public, anon;
grant execute on function public.admin_recent_activity(int) to authenticated;

-- 사이트 관리자: 날짜별 접속한 사람 수
create function public.admin_daily_active(days int default 30)
returns table (day date, users int, visits int)
language sql stable security definer set search_path = ''
as $$
  select d::date, count(x.user_id)::int, coalesce(sum(x.visits), 0)::int
    from generate_series((now() at time zone 'Asia/Seoul')::date - (greatest(1, least(days, 365)) - 1), (now() at time zone 'Asia/Seoul')::date, interval '1 day') d
    left join public.user_activity x on x.day = d::date
   where private.is_site_admin()
   group by d order by d
$$;
revoke execute on function public.admin_daily_active(int) from public, anon;
grant execute on function public.admin_daily_active(int) to authenticated;
