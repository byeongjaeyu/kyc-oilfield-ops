-- 새 주유소의 기본 운영 형태는 직접 운영. 임대 중이면 신청할 때나 주유소 설정에서 고름
alter table public.stations alter column operation set default 'self';
