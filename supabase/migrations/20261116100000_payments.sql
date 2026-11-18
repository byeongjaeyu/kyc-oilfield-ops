-- #1 입금 확인 — 월별 청구(계약에서 자동 생성) + 통장 입금 + 자동 매칭

-- 권한 영역에 payments 추가
alter table public.role_permissions drop constraint role_permissions_area_check;
alter table public.role_permissions add constraint role_permissions_area_check
  check (area in ('prices', 'land', 'policy', 'contracts', 'inspections', 'payments'));
-- 임차인은 보기만 (스스로 입금 처리를 고칠 수 없게). 필요하면 회원 관리에서 수정 권한을 켬
insert into public.role_permissions (role, area, can_read, can_write) values
  ('owner', 'payments', true, true),
  ('tenant', 'payments', true, false);

-- 계약별 입금자명 (통장에 찍히는 이름들)
alter table public.contracts add column payer_names text[] not null default '{}';
-- 이 달부터 청구를 만들고 미납을 따짐 (그 전 기록은 통장 내역을 올릴 때 앞당기면 됨)
alter table public.contracts add column payments_tracked_from date not null default date_trunc('month', now())::date;

-- 이름 비교용: 주식회사·(주)·㈜·공백·괄호를 지우고 소문자로
create function public.normalize_payer(t text) returns text
language sql immutable set search_path = ''
as $$ select regexp_replace(lower(coalesce(t, '')), '주식회사|㈜|\(주\)|[[:space:]()（）]', '', 'g') $$;

create table public.rent_charges (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  due_date date not null,
  expected_amount bigint not null check (expected_amount >= 0),
  -- 임대인이 금액을 직접 고친 청구는 계약을 고쳐도 다시 계산하지 않음
  manual boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (contract_id, period)
);
create index rent_charges_due_date_idx on public.rent_charges (due_date);

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  amount bigint not null check (amount > 0),
  payer text not null default '',
  memo text not null default '',
  source text not null check (source in ('excel', 'sms', 'manual')),
  -- 같은 거래가 엑셀·문자로 두 번 들어와도 한 건으로
  dedupe_key text not null unique,
  charge_id uuid references public.rent_charges (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index bank_transactions_charge_id_idx on public.bank_transactions (charge_id);
create index bank_transactions_created_by_idx on public.bank_transactions (created_by);
create index bank_transactions_occurred_at_idx on public.bank_transactions (occurred_at);

-- 휴대폰 입금 문자 연동용 비밀 주소
create table public.bank_webhooks (
  token text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  created_by uuid default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index bank_webhooks_created_by_idx on public.bank_webhooks (created_by);

-- ── 월별 청구 생성: 계약 기간 전체, 부가세 별도면 ×1.1, 인상일마다 인상률 복리 적용 ──
create function public.regenerate_rent_charges() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  m date;
  last_m date;
  due date;
  steps int;
  amt numeric;
begin
  if new.status <> 'confirmed' or new.start_date is null or new.end_date is null
     or new.monthly_rent is null or new.rent_due_day is null then
    delete from public.rent_charges where contract_id = new.id and not manual;
    return new;
  end if;

  m := date_trunc('month', greatest(new.start_date, new.payments_tracked_from))::date;
  last_m := date_trunc('month', new.end_date)::date;
  delete from public.rent_charges
   where contract_id = new.id and not manual
     and (to_date(period || '-01', 'YYYY-MM-DD') < m or to_date(period || '-01', 'YYYY-MM-DD') > last_m);

  while m <= last_m and m < date_trunc('month', new.start_date)::date + interval '241 months' loop
    due := least(m + (new.rent_due_day - 1), (m + interval '1 month' - interval '1 day')::date);

    steps := 0;
    if new.next_increase_date is not null and new.increase_rate is not null and due >= new.next_increase_date then
      steps := 1;
      if new.increase_every_months is not null then
        steps := 1 + floor(
          ((extract(year from age(due, new.next_increase_date)) * 12) + extract(month from age(due, new.next_increase_date)))
          / new.increase_every_months)::int;
      end if;
    end if;

    amt := new.monthly_rent * power(1 + coalesce(new.increase_rate, 0) / 100.0, steps);
    if new.vat_included is false then
      amt := amt * 1.1;
    end if;

    insert into public.rent_charges (contract_id, period, due_date, expected_amount, note)
    values (new.id, to_char(m, 'YYYY-MM'), due, round(amt)::bigint,
            case when steps > 0 then '인상 ' || steps || '회 반영(추정)' else '' end)
    on conflict (contract_id, period) do update
      set due_date = excluded.due_date, expected_amount = excluded.expected_amount, note = excluded.note
      where not public.rent_charges.manual;

    m := (m + interval '1 month')::date;
  end loop;
  return new;
end $$;

create trigger rent_charges_sync after insert or update on public.contracts
  for each row execute function public.regenerate_rent_charges();

-- ── 입금 자동 매칭: 입금자명이 계약의 입금자명과 맞으면, 그 계약에서 아직 덜 낸 가장 이른 청구에 연결 ──
create function public.match_bank_transaction() returns trigger
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
   where c.status = 'confirmed'
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

create trigger bank_transactions_match before insert on public.bank_transactions
  for each row execute function public.match_bank_transaction();

revoke execute on function public.regenerate_rent_charges() from public, anon, authenticated;
revoke execute on function public.match_bank_transaction() from public, anon, authenticated;

-- 기존 확정 계약의 청구를 지금 만들기
update public.contracts set updated_at = now() where status = 'confirmed';

-- ── 청구별 납부 현황 (RLS 를 그대로 따르는 뷰) ──
create view public.rent_charge_status with (security_invoker = true) as
select
  rc.*,
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

-- ── 권한 ──
alter table public.rent_charges enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_webhooks enable row level security;

create policy "read charges" on public.rent_charges
  for select to authenticated using ((select private.can('payments')));
create policy "write charges" on public.rent_charges
  for update to authenticated
  using ((select private.can('payments', true)))
  with check ((select private.can('payments', true)));

create policy "read transactions" on public.bank_transactions
  for select to authenticated using ((select private.can('payments')));
create policy "insert transactions" on public.bank_transactions
  for insert to authenticated with check ((select private.can('payments', true)));
create policy "update transactions" on public.bank_transactions
  for update to authenticated
  using ((select private.can('payments', true)))
  with check ((select private.can('payments', true)));
create policy "delete transactions" on public.bank_transactions
  for delete to authenticated using ((select private.can('payments', true)));

-- 문자 연동 주소는 임대인만
create policy "owner manages bank webhooks" on public.bank_webhooks
  for all to authenticated
  using ((select private.my_role()) = 'owner')
  with check ((select private.my_role()) = 'owner');
