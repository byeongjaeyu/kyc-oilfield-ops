-- #2 계약 일정 — 계약서, 계약 일정, 캘린더 구독 토큰 (전부 임대인 전용)

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  title text not null default '주유소 임대차 계약',
  tenant_name text not null default '',
  start_date date,
  end_date date,
  deposit bigint check (deposit >= 0),
  monthly_rent bigint check (monthly_rent >= 0),
  vat_included boolean,
  rent_due_day int check (rent_due_day between 1 and 31),
  auto_renew boolean,
  -- 만기 며칠 전까지 갱신 여부를 통지해야 하는지
  renewal_notice_days int check (renewal_notice_days between 0 and 730),
  increase_rate numeric(6, 2),
  increase_every_months int check (increase_every_months between 1 and 120),
  next_increase_date date,
  increase_rule text not null default '',
  restoration text not null default '',
  restoration_items text[] not null default '{}',
  -- 항목별 계약서 원문 인용 (AI 추출 결과 검토용)
  quotes jsonb not null default '{}',
  file_path text,
  file_name text,
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contract_events (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  kind text not null check (kind in ('계약 시작', '만기', '갱신 통지 마감', '임대료 인상', '기타')),
  date date not null,
  title text not null,
  note text not null default '',
  -- 계약 정보에서 자동으로 만든 일정(true)은 계약을 고치면 다시 만들어지고, 직접 넣은 일정(false)은 남는다
  auto boolean not null default false,
  created_at timestamptz not null default now()
);
create index contract_events_contract_id_idx on public.contract_events (contract_id);
create index contract_events_date_idx on public.contract_events (date);

create table public.calendar_feeds (
  token text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  created_by uuid default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index calendar_feeds_created_by_idx on public.calendar_feeds (created_by);

create trigger touch_contracts before update on public.contracts
  for each row execute function public.touch_updated_at();

-- 확정된 계약의 자동 일정 다시 만들기
create function public.regenerate_contract_events() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  d date;
  n int := 0;
begin
  delete from public.contract_events where contract_id = new.id and auto;
  if new.status <> 'confirmed' then
    return new;
  end if;

  if new.start_date is not null then
    insert into public.contract_events (contract_id, kind, date, title, auto)
    values (new.id, '계약 시작', new.start_date, new.title || ' 시작', true);
  end if;

  if new.end_date is not null then
    insert into public.contract_events (contract_id, kind, date, title, auto)
    values (new.id, '만기', new.end_date, new.title || ' 만기', true);

    if new.renewal_notice_days is not null then
      insert into public.contract_events (contract_id, kind, date, title, note, auto)
      values (new.id, '갱신 통지 마감', new.end_date - new.renewal_notice_days,
              new.title || ' 갱신 통지 마감',
              '만기 ' || new.renewal_notice_days || '일 전까지 갱신 여부 통지', true);
    end if;
  end if;

  if new.next_increase_date is not null then
    d := new.next_increase_date;
    loop
      exit when n >= 10 or (new.end_date is not null and d > new.end_date);
      insert into public.contract_events (contract_id, kind, date, title, note, auto)
      values (new.id, '임대료 인상', d, new.title || ' 임대료 인상',
              coalesce(nullif(new.increase_rule, ''), coalesce(new.increase_rate::text || '% 인상', '')), true);
      n := n + 1;
      exit when new.increase_every_months is null;
      d := (d + make_interval(months => new.increase_every_months))::date;
    end loop;
  end if;

  return new;
end $$;

create trigger contract_events_sync after insert or update on public.contracts
  for each row execute function public.regenerate_contract_events();

revoke execute on function public.regenerate_contract_events() from public, anon, authenticated;

alter table public.contracts enable row level security;
alter table public.contract_events enable row level security;
alter table public.calendar_feeds enable row level security;

create policy "owner manages contracts" on public.contracts
  for all to authenticated
  using ((select private.my_role()) = 'owner')
  with check ((select private.my_role()) = 'owner');

create policy "owner manages contract events" on public.contract_events
  for all to authenticated
  using ((select private.my_role()) = 'owner')
  with check ((select private.my_role()) = 'owner');

create policy "owner manages calendar feeds" on public.calendar_feeds
  for all to authenticated
  using ((select private.my_role()) = 'owner')
  with check ((select private.my_role()) = 'owner');

-- 계약서 파일 (비공개, 임대인만)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-files', 'contract-files', false, 31457280, array['application/pdf', 'image/jpeg', 'image/png']);

create policy "owner reads contract files" on storage.objects
  for select to authenticated
  using (bucket_id = 'contract-files' and (select private.my_role()) = 'owner');
create policy "owner uploads contract files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'contract-files' and (select private.my_role()) = 'owner');
create policy "owner deletes contract files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'contract-files' and (select private.my_role()) = 'owner');
