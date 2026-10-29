-- Web dashboard (20261029120000_admin_dashboard.sql): configurable AI limits, the admin audit log and the
-- Administração read models. Everything is service-only; a signed-in student can call none of it.
begin;
select no_plan();

insert into auth.users (id, email, last_sign_in_at, banned_until) values
  ('11111111-1111-4111-8111-111111111111', 'dona@studify.test', now() - interval '1 hour', null),
  ('22222222-2222-4222-8222-222222222222', 'ana@studify.test', now() - interval '2 days', null),
  ('33333333-3333-4333-8333-333333333333', 'bruno@studify.test', null, now() + interval '30 days'),
  ('44444444-4444-4444-8444-444444444444', 'carla_x@studify.test', null, null);
insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, app_role, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'Dona', 'approved', 1990, 1, 'v1', now(), 'app_admin', now() - interval '60 days'),
  ('22222222-2222-4222-8222-222222222222', 'Ana', 'approved', 2009, 3, 'v1', now(), 'user', now() - interval '3 days'),
  ('33333333-3333-4333-8333-333333333333', 'Bruno', 'pending', 2000, 6, 'v1', now(), 'user', now() - interval '20 days'),
  ('44444444-4444-4444-8444-444444444444', 'Carla', 'approved', 2001, 2, 'v1', now(), 'user', now() - interval '10 days');

insert into public.class_groups (id, name, owner_id, ai_budget_monthly_micro_usd) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '3º A', '22222222-2222-4222-8222-222222222222', null),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2º B', '44444444-4444-4444-8444-444444444444', 7000000);
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'owner', 'active', now()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'member', 'pending', null),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '44444444-4444-4444-8444-444444444444', 'owner', 'active', now());

-- ---------------------------------------------------------------- limits

select is(private.ai_budget_limit('user', '22222222-2222-4222-8222-222222222222', 'day'), 1000000::bigint,
          'without settings, the user limit is the $1/day placeholder');
select is(private.ai_budget_limit('global', '00000000-0000-0000-0000-000000000000', 'month'), 100000000::bigint,
          'without settings, the global cap is the $100/month placeholder');
select is(private.ai_budget_limit('class_group', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'month'), 7000000::bigint,
          'a Turma limit set on the Turma still applies');

-- A budget row for today, created under the old default.
select private.ai_budget_settle(private.ai_budget_reserve('22222222-2222-4222-8222-222222222222', null, 'TUT-01', 'user', 400000), 400000);
select is((select limit_micro_usd from private.ai_budgets where scope_type = 'user' and scope_id = '22222222-2222-4222-8222-222222222222'),
          1000000::bigint, 'the open day copied the old default');

select is(private.ai_budget_set_limit('user', '00000000-0000-0000-0000-000000000000', 300000, '11111111-1111-4111-8111-111111111111'),
          300000::bigint, 'setting the default user limit returns the new limit');
select is((select limit_micro_usd from private.ai_budgets where scope_type = 'user' and scope_id = '22222222-2222-4222-8222-222222222222'),
          300000::bigint, 'a new default reaches the open day at once');
select throws_ok(
  $$select private.ai_budget_reserve('22222222-2222-4222-8222-222222222222', null, 'TUT-01', 'user', 1000)$$,
  'P0001', 'budget_exhausted', 'the lower limit gates the next call (400k spent of 300k)');

select is(private.ai_budget_set_limit('user', '22222222-2222-4222-8222-222222222222', 2000000, '11111111-1111-4111-8111-111111111111'),
          2000000::bigint, 'a student override wins over the default');
select is(private.ai_budget_limit('user', '33333333-3333-4333-8333-333333333333', 'day'), 300000::bigint,
          'other students keep the default');
select lives_ok(
  $$select private.ai_budget_settle(private.ai_budget_reserve('22222222-2222-4222-8222-222222222222', null, 'TUT-01', 'user', 1000), 1000)$$,
  'the override lets the student continue today');

select is(private.ai_budget_set_limit('user', '22222222-2222-4222-8222-222222222222', null, '11111111-1111-4111-8111-111111111111'),
          300000::bigint, 'clearing the override falls back to the default');
select is(private.ai_budget_set_limit('class_group', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, '11111111-1111-4111-8111-111111111111'),
          50000000::bigint, 'clearing a Turma limit falls back to the Turma default');
select is((select ai_budget_monthly_micro_usd from public.class_groups where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          null::bigint, 'the Turma limit is stored on the Turma');
select throws_ok(
  $$select private.ai_budget_set_limit('class_group', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1, null)$$,
  'P0002', 'not_found', 'an unknown Turma is not found');
select throws_ok(
  $$select private.ai_budget_set_limit('global', '22222222-2222-4222-8222-222222222222', 1, null)$$,
  '22023', 'invalid budget scope id', 'the global cap has no per-scope rows');
select throws_ok(
  $$select private.ai_budget_set_limit('user', '00000000-0000-0000-0000-000000000000', -1, null)$$,
  '22023', 'invalid limit', 'a negative limit is refused');

select is(private.ai_budget_set_limit('global', '00000000-0000-0000-0000-000000000000', 250000000, null), 250000000::bigint,
          'the global cap can be raised');
select is((private.admin_limits()->'global_month'->>'effective')::bigint, 250000000::bigint, 'admin_limits reports the cap');
select is((private.admin_limits()->'global_month'->>'builtin')::bigint, 100000000::bigint, 'admin_limits keeps the placeholder');
select is((private.admin_limits()->'user_day'->>'configured')::bigint, 300000::bigint, 'admin_limits reports the configured default');
select is((private.admin_limits()->'class_group_month'->>'configured'), null, 'an unset default reads as null');

-- ---------------------------------------------------------------- audit log

insert into private.admin_audit (actor_id, action, target_type, target_id, details)
values ('11111111-1111-4111-8111-111111111111', 'user.set_role', 'profile', '33333333-3333-4333-8333-333333333333', '{"role":"user"}');
select throws_ok($$update private.admin_audit set action = 'x'$$, '42501', null, 'the audit log is append-only (update)');
select throws_ok($$delete from private.admin_audit$$, '42501', null, 'the audit log is append-only (delete)');
select throws_ok($$insert into private.admin_audit (action, target_type, details) values ('a', 'b', '[]')$$,
                 '23514', null, 'details must be an object');
insert into private.admin_audit (actor_id, action, target_type, target_id, created_at)
values ('11111111-1111-4111-8111-111111111111', 'settings.set_limits', 'settings', null, now() - interval '1 day');
select is(jsonb_array_length(private.admin_audit_list(50, null, null)), 2, 'the log lists every entry');
select is(private.admin_audit_list(50, null, null)->0->>'actor_name', 'Dona', 'entries carry the actor''s name');
select is(private.admin_audit_list(50, null, null)->0->>'action', 'user.set_role', 'newest first');
select is(jsonb_array_length(private.admin_audit_list(50, now() - interval '1 hour', null)), 1, 'p_before pages back');
select is(jsonb_array_length(private.admin_audit_list(50, null, '33333333-3333-4333-8333-333333333333')), 1, 'p_target narrows to one target');

-- ---------------------------------------------------------------- read models

insert into public.ai_usage (user_id, class_group_id, feature, task, model, fallback_model, cost_micro_usd, price_version, latency_ms,
                             input_tokens, cache_read_input_tokens, stop_reason, refusal_category, created_at) values
  ('22222222-2222-4222-8222-222222222222', null, 'TUT-01', 'tutor.turn', 'claude-sonnet-5-5', null, 120000, 'p1', 900, 1000, 3000, 'end_turn', null, now()),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ING-01', 'ing.outline', 'claude-opus-5-5', 'claude-sonnet-5-5', 500000, 'p1', 4000, 8000, 0, 'end_turn', null, now()),
  ('44444444-4444-4444-8444-444444444444', null, 'TUT-01', 'tutor.turn', 'claude-sonnet-5-5', null, 30000, 'p1', 700, 1000, 0, 'refusal', 'bio', now()),
  ('33333333-3333-4333-8333-333333333333', null, 'LRN-03', 'learn.explain', 'claude-sonnet-5-5', null, 10000, 'p1', 500, 500, 0, 'end_turn', null, now() - interval '40 days');
insert into public.daily_activity (user_id, local_date, active_minutes, reviews) values
  ('44444444-4444-4444-8444-444444444444', (now() at time zone 'America/Sao_Paulo')::date - 1, 25, 30),
  ('33333333-3333-4333-8333-333333333333', (now() at time zone 'America/Sao_Paulo')::date - 12, 10, 0);
insert into public.user_reports (reporter_id, reported_id, class_group_id, reason, status) values
  ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'inappropriate_name', 'open');
insert into public.ai_jobs (type, user_id, status, error_code) values
  ('ingest.outline', '22222222-2222-4222-8222-222222222222', 'failed', 'ai_failed');
insert into public.account_deletions (user_id, requested_by, status) values ('44444444-4444-4444-8444-444444444444', 'self', 'pending');

select is((private.admin_overview()->'users'->>'total')::int, 4, 'overview counts every profile');
select is((private.admin_overview()->'users'->>'admins')::int, 1, 'overview counts the admins');
select is((private.admin_overview()->'users'->>'new_7d')::int, 1, 'overview counts the sign-ups of the week');
select is((private.admin_overview()->'users'->>'active_7d')::int, 2, 'active = studied or used AI in the last 7 days');
select is((private.admin_overview()->'users'->>'suspended')::int, 1, 'overview counts suspended accounts');
select is((private.admin_overview()->'spend'->>'today')::bigint, 650000::bigint, 'today''s spend sums every call of the day');
select is((private.admin_overview()->'spend'->>'cap')::bigint, 250000000::bigint, 'the overview shows the global cap');
select is(jsonb_array_length(private.admin_overview()->'series'), 30, 'the series has 30 days, zeros included');
select is((private.admin_overview()->'series'->29->>'cost')::bigint, 650000::bigint, 'the last day of the series is today');
select is((private.admin_overview()->'moderation'->>'open_reports')::int, 1, 'open reports are counted');
select is((private.admin_overview()->'moderation'->>'pending_names')::int, 1, 'pending names are counted');
select is((private.admin_overview()->'ops'->>'failed_jobs_24h')::int, 1, 'failed operations of the last day are counted');
select is((private.admin_overview()->'ops'->>'pending_deletions')::int, 1, 'pending deletions are counted');
select is(private.admin_overview()->'spend'->'top_features'->0->>'feature', 'ING-01', 'the costliest feature comes first');
select is(private.admin_overview()->'spend'->'top_class_groups'->0->>'name', '3º A', 'Turma spend names the Turma');

select is((private.admin_ai_report(7)->'totals'->>'calls')::int, 3, 'the report covers only the period');
select is((private.admin_ai_report(90)->'totals'->>'calls')::int, 4, 'a longer period includes older calls');
select is((private.admin_ai_report(7)->'totals'->>'refusals')::int, 1, 'refusals are counted');
select is((private.admin_ai_report(7)->'totals'->>'fallbacks')::int, 1, 'fallbacks are counted');
select is(jsonb_array_length(private.admin_ai_report(7)->'by_day'), 7, 'one entry per day of the period');
select is(private.admin_ai_report(7)->'by_model'->0->>'model', 'claude-sonnet-5-5', 'models are grouped by the model that served');
select is((private.admin_ai_report(7)->'by_feature'->1->>'cache_ratio')::numeric, 0.6, 'cache ratio = cache reads / all input');
select is(private.admin_ai_report(7)->'refusals_by_category'->0->>'category', 'bio', 'refusals are grouped by category');
select is((private.admin_ai_report(7)->>'personal_cost')::bigint, 150000::bigint, 'personal spend is reported apart from Turmas');
select is((private.admin_ai_report(0)->>'days')::int, 1, 'the period is clamped to at least one day');

select is((private.admin_users(null, 'all', 25, 0)->>'total')::int, 4, 'the user list has every profile');
select is(private.admin_users(null, 'all', 25, 0)->'rows'->0->>'display_name', 'Ana', 'newest first');
select is((private.admin_users('ANA@', 'all', 25, 0)->>'total')::int, 1, 'search matches the e-mail, case-insensitively');
select is((private.admin_users('a_', 'all', 25, 0)->>'total')::int, 1, 'an underscore in the search is a literal');
select is((private.admin_users('%', 'all', 25, 0)->>'total')::int, 0, 'a percent sign in the search is a literal');
select is((private.admin_users(null, 'suspended', 25, 0)->'rows'->0->>'display_name'), 'Bruno', 'the suspended filter');
select is((private.admin_users(null, 'pending_names', 25, 0)->>'total')::int, 1, 'the pending-name filter');
select is((private.admin_users(null, 'admins', 25, 0)->>'total')::int, 1, 'the admin filter');
select is((private.admin_users(null, 'minors', 25, 0)->'rows'->0->>'display_name'), 'Ana', 'the minors filter');
select is((private.admin_users(null, 'deleting', 25, 0)->'rows'->0->>'display_name'), 'Carla', 'the deletion filter');
select is(jsonb_array_length(private.admin_users(null, 'all', 2, 2)->'rows'), 2, 'pages by limit and offset');
select is((private.admin_users('Ana', 'all', 25, 0)->'rows'->0->>'cost_30d')::bigint, 620000::bigint, 'the row carries the 30-day spend');
select throws_ok($$select private.admin_users(null, 'everyone', 25, 0)$$, '22023', null, 'an unknown filter is refused');

select is(private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'auth'->>'email', 'ana@studify.test', 'detail reads the sign-in e-mail');
select is((private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'profile'->>'is_minor')::boolean, true, 'detail marks minors');
select is((private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'spend'->>'today')::bigint, 620000::bigint, 'detail sums today''s spend');
select is((private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'limit'->>'effective')::bigint, 300000::bigint, 'detail shows the limit that applies');
select is(jsonb_array_length(private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'class_groups'), 1, 'detail lists the Turmas');
select is(jsonb_array_length(private.admin_user_detail('22222222-2222-4222-8222-222222222222')->'jobs'), 1, 'detail lists recent operations');
select is((private.admin_user_detail('11111111-1111-4111-8111-111111111111')->'limit'->>'exempt')::boolean, true, 'admins are exempt from limits');
select is(private.admin_user_detail('99999999-9999-4999-8999-999999999999'), null, 'no profile, no detail');

select is(jsonb_array_length(private.admin_class_groups()), 2, 'every live Turma is listed');
select is((select (x->>'cost_month')::bigint from jsonb_array_elements(private.admin_class_groups()) x where x->>'name' = '3º A'),
          500000::bigint, 'Turma spend this month');
select is((select (x->>'pending')::int from jsonb_array_elements(private.admin_class_groups()) x where x->>'name' = '3º A'),
          1, 'pending members are counted apart');

select is(jsonb_array_length(private.admin_moderation()->'reports'), 1, 'open reports are in the queue');
select is(private.admin_moderation()->'reports'->0->>'reported_name', 'Bruno', 'a report names the reported student');
select is(jsonb_array_length(private.admin_moderation()->'pending_names'), 1, 'names waiting for review are in the queue');

-- ---------------------------------------------------------------- privileges

select is((test_helpers.try_as('authenticated', '22222222-2222-4222-8222-222222222222', 'select private.admin_overview()'))->>'err' like '42501%',
          true, 'a student cannot read the overview');
select is((test_helpers.try_as('authenticated', '11111111-1111-4111-8111-111111111111', 'select private.admin_users(null, ''all'', 25, 0)'))->>'err' like '42501%',
          true, 'not even an admin reaches the functions with a client token (the API calls them)');
select is((test_helpers.try_as('authenticated', '11111111-1111-4111-8111-111111111111',
          'select private.ai_budget_set_limit(''global'', ''00000000-0000-0000-0000-000000000000'', 1, null)'))->>'err' like '42501%',
          true, 'limits cannot be changed with a client token');
select is((test_helpers.try_as('authenticated', '11111111-1111-4111-8111-111111111111', 'select * from private.admin_audit'))->>'err' like '42501%',
          true, 'the audit log is not readable with a client token');
select is((test_helpers.try_as('authenticated', '11111111-1111-4111-8111-111111111111', 'select * from private.ai_budget_limits'))->>'err' like '42501%',
          true, 'the limit settings are not readable with a client token');

select * from finish();
rollback;
