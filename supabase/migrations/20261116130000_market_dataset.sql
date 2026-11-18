-- 국제유가·환율(market/…)은 업계 정책처럼 모든 주유소 공통 — 어느 주유소에서든 가격 비교를 볼 수 있으면 읽음
drop policy "read datasets" on public.datasets;
create policy "read datasets" on public.datasets
  for select to authenticated
  using (case split_part(key, '/', 1)
           when 'policy' then (select private.can_any('policy'))
           when 'market' then (select private.can_any('prices'))
           when 'st' then private.can_text(split_part(key, '/', 2), split_part(key, '/', 3))
           else false end);
