-- 로그인 전 데모: 이름·주소를 가린 데모용 수집 데이터(demo/…)는 누구나 읽기
--  만드는 건 jobs/demo-export.ts (서비스 키). 주유소 장부 데이터는 데모에 쓰지 않음 (브라우저 안 예시 데이터)
grant select on public.datasets to anon;
create policy "anyone reads demo datasets" on public.datasets
  for select to anon, authenticated using (key like 'demo/%');
