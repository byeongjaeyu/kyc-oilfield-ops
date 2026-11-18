-- 서버(Edge Function)만 읽는 키 보관 — GitHub 시크릿에서 Actions 가 서비스 키로 넣음
--  브라우저(anon·authenticated)에서는 읽기·쓰기 모두 불가. 서비스 키만 RLS 를 건너뜀
create table public.app_secrets (
  name text primary key check (name ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
