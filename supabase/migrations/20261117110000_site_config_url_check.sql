-- 후원 링크 형식 검사 고침: Postgres 정규식 반복 횟수는 255 까지라 {4,300} 이 오류였음 (어떤 링크도 저장 안 됨)
alter table public.site_config drop constraint site_config_donate_url_check;
alter table public.site_config add constraint site_config_donate_url_check
  check (donate_url = '' or (donate_url ~ '^https://\S+$' and length(donate_url) <= 300));
