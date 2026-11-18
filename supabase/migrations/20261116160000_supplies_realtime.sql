-- 카운터 화면: 다른 기기에서 판매·입고하면 재고 숫자가 바로 바뀌도록 실시간 변경 알림
--  (실시간 알림도 RLS 를 따르므로 그 주유소 구성원에게만 감)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'supply_items'
  ) then
    alter publication supabase_realtime add table public.supply_items;
  end if;
end $$;
