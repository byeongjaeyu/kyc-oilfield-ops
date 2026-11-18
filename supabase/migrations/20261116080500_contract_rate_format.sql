-- 인상률 표기 "3.00%" → "3%"
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
      values (new.id, '임대료 인상', d, new.title || ' 임대료 인상',
              coalesce(nullif(new.increase_rule, ''), coalesce(rate || '% 인상', '')), true);
      n := n + 1;
      exit when new.increase_every_months is null;
      d := (d + make_interval(months => new.increase_every_months))::date;
    end loop;
  end if;

  return new;
end $$;

revoke execute on function public.regenerate_contract_events() from public, anon, authenticated;
