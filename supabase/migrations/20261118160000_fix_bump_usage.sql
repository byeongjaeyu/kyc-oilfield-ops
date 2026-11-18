-- bump_usage: 매개변수 fn 과 칸 이름 fn 이 겹쳐 실행 오류 → 변수 우선, 충돌 대상은 기본키 이름으로
create or replace function public.bump_usage(uid uuid, fn text, per_user int, total int) returns boolean
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_variable
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  mine int;
  everyone int;
begin
  insert into private.usage_counts as c (user_id, fn, day, n) values (uid, fn, today, 1)
    on conflict on constraint usage_counts_pkey do update set n = c.n + 1
    returning c.n into mine;
  insert into private.usage_counts as c (user_id, fn, day, n) values ('00000000-0000-0000-0000-000000000000', fn, today, 1)
    on conflict on constraint usage_counts_pkey do update set n = c.n + 1
    returning c.n into everyone;
  return mine <= per_user and everyone <= total;
end $$;
revoke execute on function public.bump_usage(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, text, int, int) to service_role;
