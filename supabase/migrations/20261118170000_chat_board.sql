-- 자유게시판 (화면 오른쪽 채팅): 로그인한 사장님 누구나, 대화명으로만 보임 (이메일·주유소는 안 보임)
--  - 대화명은 한 번 정하고 바꿀 수 있음. '운영자'·'관리자' 같은 이름은 사이트 관리자만
--  - 글은 3초에 한 번, 하루 200개까지. 본인·사이트 관리자만 지움
--  - 신고 3번이면 자동으로 내려감 (내린 글은 관리자만 보는 private 표에 사본)

create table public.chat_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (nickname ~ '^[가-힣A-Za-z0-9_.-]{2,12}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index chat_profiles_nickname_key on public.chat_profiles (lower(nickname));

create function public.guard_chat_profile() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.user_id := (select auth.uid());
  new.updated_at := now();
  if lower(new.nickname) ~ '(운영자|관리자|만땅|admin|manddang|staff)' and not (select private.is_site_admin()) then
    raise exception '이 대화명은 쓸 수 없습니다.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.guard_chat_profile() from public, anon, authenticated;
create trigger guard_chat_profile before insert or update on public.chat_profiles
  for each row execute function public.guard_chat_profile();

alter table public.chat_profiles enable row level security;
create policy "read nicknames" on public.chat_profiles for select to authenticated using (true);
create policy "set own nickname" on public.chat_profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "change own nickname" on public.chat_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ── 글 ──
create table public.chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  nickname text not null default '',
  is_admin boolean not null default false,
  body text not null check (length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index chat_messages_created_idx on public.chat_messages (created_at desc);
create index chat_messages_user_idx on public.chat_messages (user_id, created_at desc);

create function public.prepare_chat_message() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  nick text;
begin
  select nickname into nick from public.chat_profiles where user_id = me;
  if nick is null then
    raise exception '대화명을 먼저 정해 주세요.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.chat_messages where user_id = me and created_at > now() - interval '3 seconds') then
    raise exception '조금 천천히 보내 주세요.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.chat_messages where user_id = me and created_at > now() - interval '1 day') >= 200 then
    raise exception '오늘은 글을 너무 많이 썼습니다. 내일 다시 써 주세요.' using errcode = 'P0001';
  end if;
  new.user_id := me;
  new.nickname := nick;
  new.is_admin := (select private.is_site_admin());
  new.body := btrim(new.body);
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.prepare_chat_message() from public, anon, authenticated;
create trigger prepare_chat_message before insert on public.chat_messages
  for each row execute function public.prepare_chat_message();

alter table public.chat_messages enable row level security;
create policy "read board" on public.chat_messages for select to authenticated using (true);
create policy "write board" on public.chat_messages for insert to authenticated with check (user_id = (select auth.uid()));
create policy "delete own or admin" on public.chat_messages for delete to authenticated
  using (user_id = (select auth.uid()) or (select private.is_site_admin()));
revoke update on public.chat_messages from anon, authenticated;

-- ── 신고 ──
create table private.chat_removed (
  id bigint primary key,
  user_id uuid,
  nickname text,
  body text,
  created_at timestamptz,
  removed_at timestamptz not null default now(),
  reason text not null
);

create table public.chat_reports (
  message_id bigint not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index chat_reports_user_idx on public.chat_reports (user_id);
alter table public.chat_reports enable row level security;
create policy "report" on public.chat_reports for insert to authenticated with check (user_id = (select auth.uid()));
create policy "admin reads reports" on public.chat_reports for select to authenticated using ((select private.is_site_admin()));

create function public.after_chat_report() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.chat_reports where message_id = new.message_id) >= 3 then
    insert into private.chat_removed (id, user_id, nickname, body, created_at, reason)
      select id, user_id, nickname, body, created_at, '신고 3건' from public.chat_messages where id = new.message_id
      on conflict (id) do nothing;
    delete from public.chat_messages where id = new.message_id;
  end if;
  return null;
end $$;
revoke execute on function public.after_chat_report() from public, anon, authenticated;
create trigger after_chat_report after insert on public.chat_reports
  for each row execute function public.after_chat_report();

-- 화면에 바로 뜨도록
alter publication supabase_realtime add table public.chat_messages;
