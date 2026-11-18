-- 유류 장부 4단계 — 반복 할 일 (임차인 전용): 매주·매달 돌아오는 신고·납부를 체크
create table public.routines (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations (id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  cadence text not null check (cadence in ('weekly', 'monthly')),
  -- weekly: 0(일)~6(토), monthly: 1~31 (그 달에 없는 날이면 말일)
  due_day int not null,
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((cadence = 'weekly' and due_day between 0 and 6) or (cadence = 'monthly' and due_day between 1 and 31))
);
create index routines_station_idx on public.routines (station_id);

-- 한 번 한 것: period 는 주간이면 그 주 월요일(YYYY-MM-DD), 월간이면 YYYY-MM
create table public.routine_checks (
  routine_id uuid not null references public.routines (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-\d{2}(-\d{2})?$'),
  station_id uuid not null references public.stations (id) on delete cascade,
  done_by uuid default auth.uid() references auth.users (id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (routine_id, period)
);
create index routine_checks_station_idx on public.routine_checks (station_id);
create index routine_checks_done_by_idx on public.routine_checks (done_by);

-- 체크의 주유소는 할 일의 주유소를 따라감
create function public.routine_check_station() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  select station_id into new.station_id from public.routines where id = new.routine_id;
  return new;
end $$;
revoke execute on function public.routine_check_station() from public, anon, authenticated;
create trigger routine_check_station before insert on public.routine_checks
  for each row execute function public.routine_check_station();

alter table public.routines enable row level security;
alter table public.routine_checks enable row level security;
create policy "read routines" on public.routines for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add routines" on public.routines for insert to authenticated with check ((select private.can_fuel(station_id, true)));
create policy "edit routines" on public.routines for update to authenticated
  using ((select private.can_fuel(station_id, true))) with check ((select private.can_fuel(station_id, true)));
create policy "delete routines" on public.routines for delete to authenticated using ((select private.can_fuel(station_id, true)));
create policy "read routine checks" on public.routine_checks for select to authenticated using ((select private.can_fuel(station_id)));
create policy "add routine checks" on public.routine_checks for insert to authenticated
  with check (exists (select 1 from public.routines r where r.id = routine_id and private.can_fuel(r.station_id, true)));
create policy "delete routine checks" on public.routine_checks for delete to authenticated using ((select private.can_fuel(station_id, true)));
