-- 사이트 전체 설정 (한 줄) — 개발자 커피 후원 링크
--  후원 링크는 누구나 볼 수 있는 공개 정보, 고치는 건 사이트 관리자만
create table public.site_config (
  id boolean primary key default true check (id),
  donate_url text not null default '' check (donate_url = '' or donate_url ~ '^https://[^\s]{4,300}$'),
  donate_note text not null default '' check (length(donate_note) <= 200),
  updated_at timestamptz not null default now()
);
insert into public.site_config default values;
create trigger touch_site_config before update on public.site_config
  for each row execute function public.touch_updated_at();

alter table public.site_config enable row level security;
grant select on public.site_config to anon, authenticated;
create policy "read site config" on public.site_config for select to anon, authenticated using (true);
create policy "edit site config" on public.site_config for update to authenticated
  using ((select private.is_site_admin())) with check ((select private.is_site_admin()));
