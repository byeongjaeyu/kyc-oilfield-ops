-- 계약 일정을 임대차만이 아니라 주유소의 모든 계약에: 정유사 공급계약, 렌탈·리스(세차기·단말기), 유지보수·보험 등
--  - contracts.kind 로 나누고, 월세 청구·입금 매칭은 임대차(lease)만
--  - 직접 운영 주유소에도 '계약 일정' 탭이 보임 (입금 확인 탭은 임대 중일 때만)

alter table public.contracts
  add column kind text not null default 'lease' check (kind in ('lease', 'supply', 'rental', 'service', 'etc'));

create or replace function public.regenerate_rent_charges() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  m date;
  last_m date;
  due date;
  steps int;
  amt numeric;
begin
  if new.kind <> 'lease' or new.status <> 'confirmed' or new.start_date is null or new.end_date is null
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

create or replace function public.regenerate_contract_events() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  d date;
  n int := 0;
  rate text := case when new.increase_rate is null then null
                    else trim(trailing '.' from trim(trailing '0' from new.increase_rate::text)) end;
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
      values (new.id, '임대료 인상', d, new.title || case when new.kind = 'lease' then ' 임대료 인상' else ' 요금·단가 인상' end,
              coalesce(nullif(new.increase_rule, ''), coalesce(rate || '% 인상', '')), true);
      n := n + 1;
      exit when new.increase_every_months is null;
      d := (d + make_interval(months => new.increase_every_months))::date;
    end loop;
  end if;

  return new;
end $$;

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
     and c.kind = 'lease'
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

revoke execute on function public.regenerate_rent_charges() from public, anon, authenticated;
revoke execute on function public.regenerate_contract_events() from public, anon, authenticated;
revoke execute on function public.match_bank_transaction() from public, anon, authenticated;
