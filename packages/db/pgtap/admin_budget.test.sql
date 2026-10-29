-- App admins have no AI budget: reservations of any size pass and hold nothing, other users keep theirs.
begin;
select no_plan();

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'admin@studify.test'),
  ('22222222-2222-4222-8222-222222222222', 'student@studify.test');
insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, app_role) values
  ('11111111-1111-4111-8111-111111111111', 'Admin', 'approved', 1990, 1, 'v1', now(), 'app_admin'),
  ('22222222-2222-4222-8222-222222222222', 'Aluna', 'approved', 2009, 3, 'v1', now(), 'user');

-- $500, far over the $1 daily user limit and the $100 global month.
select lives_ok(
  $$select private.ai_budget_settle(private.ai_budget_reserve('11111111-1111-4111-8111-111111111111', null, 'ING-01', 'content', 500000000), 500000000)$$,
  'an admin call over every limit is reserved and settled');
select is((select count(*)::int from private.ai_budgets), 0, 'an admin call holds and spends no budget row');
select is((select count(*)::int from private.ai_budget_reservations), 0, 'an admin call leaves no reservation');

select throws_ok(
  $$select private.ai_budget_reserve('22222222-2222-4222-8222-222222222222', null, 'ING-01', 'content', 2000000)$$,
  'P0001', 'budget_exhausted', 'a student is still held to the daily limit');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is((public.my_ai_usage_today()->>'pct')::int, 0, 'the usage meter shows an admin as 0% used');
reset role;

select * from finish();
rollback;
