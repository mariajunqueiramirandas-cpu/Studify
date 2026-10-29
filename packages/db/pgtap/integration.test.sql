-- Integration pass (20260104000000_integration.sql): the replaced CHECKs accept the new values and keep the
-- old ones, the new ai_usage columns exist and are nullable, the quiz diagnostic mode is stored, and battles
-- keeps `reveal`. Rolled back at the end.

begin;
select no_plan();

-- ---- seed (superuser): one student, one subject, one unit ----------------
insert into auth.users (id, email) values ('a1000000-0000-4000-8000-000000000001', 'int1@studify.test');
insert into public.profiles (id, display_name, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('a1000000-0000-4000-8000-000000000001', 'Ines', 2010, 4, 'v1', now());
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Biologia', '#123456', 'leaf');
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'unit', 'Unidade');

-- ---- plan_runs.trigger: the two new replan triggers, old values kept ----
select lives_ok(
  $$insert into public.plan_runs (user_id, version, trigger, input_hash) values ('a1000000-0000-4000-8000-000000000001', 1, 'mastery_shift', 'h-mastery')$$,
  'plan_runs accepts the mastery_shift trigger');
select lives_ok(
  $$insert into public.plan_runs (user_id, version, trigger, input_hash) values ('a1000000-0000-4000-8000-000000000001', 2, 'manual_edit', 'h-manual')$$,
  'plan_runs accepts the manual_edit trigger');
select lives_ok(
  $$insert into public.plan_runs (user_id, version, trigger, input_hash) values ('a1000000-0000-4000-8000-000000000001', 3, 'nightly', 'h-nightly')$$,
  'plan_runs still accepts the nightly trigger');
select test_helpers.check_sqlstate('plan_runs rejects a trigger the planner never records',
  $$insert into public.plan_runs (user_id, version, trigger, input_hash) values ('a1000000-0000-4000-8000-000000000001', 4, 'bogus_trigger', 'h-bogus')$$, '23514');

-- ---- knowledge_nodes.content_status: ai_refused added, old values kept -----
select lives_ok(
  $$update public.knowledge_nodes set content_status = 'ai_refused' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  'a topic can be marked ai_refused');
select lives_ok(
  $$update public.knowledge_nodes set content_status = 'ready' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  'a topic can still be marked ready');
select test_helpers.check_sqlstate('content_status rejects unknown values',
  $$update public.knowledge_nodes set content_status = 'refused_by_model' where id = 'a3000000-0000-4000-8000-000000000001'$$, '23514');

-- ---- ai_usage: the call-level columns exist, are nullable and accept values -----
select has_column('public', 'ai_usage', 'budget_class', 'ai_usage has budget_class');
select has_column('public', 'ai_usage', 'mode', 'ai_usage has mode');
select has_column('public', 'ai_usage', 'attempt', 'ai_usage has attempt');
select has_column('public', 'ai_usage', 'error_code', 'ai_usage has error_code');
select has_column('public', 'ai_usage', 'ttft_ms', 'ai_usage has ttft_ms');
select has_column('public', 'ai_usage', 'batch_id', 'ai_usage has batch_id');
select has_column('public', 'ai_usage', 'custom_id', 'ai_usage has custom_id');
select ok(
  (select bool_and(is_nullable = 'YES') from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_usage'
      and column_name in ('budget_class', 'mode', 'attempt', 'error_code', 'ttft_ms', 'batch_id', 'custom_id')),
  'the new ai_usage columns are nullable');
select lives_ok(
  $$insert into public.ai_usage (feature, task, model, cost_micro_usd, price_version)
    values ('MEM-01', 'cards.generate', 'claude-opus-5-5', 0, 'v1')$$,
  'an ai_usage row without the new columns is still valid');
select lives_ok(
  $$insert into public.ai_usage (feature, task, model, cost_micro_usd, price_version, budget_class, mode, attempt, error_code, ttft_ms, batch_id, custom_id)
    values ('MEM-01', 'cards.generate', 'claude-opus-5-5', 12, 'v1', 'content', 'batch', 2, 'ai_invalid_output', 180, 'msgbatch_1', 'w1_2')$$,
  'an ai_usage row carries the batch and retry fields');
select test_helpers.check_sqlstate('ai_usage ttft_ms cannot be negative',
  $$insert into public.ai_usage (feature, task, model, cost_micro_usd, price_version, ttft_ms) values ('MEM-01', 'cards.generate', 'claude-opus-5-5', 0, 'v1', -1)$$, '23514');

-- ---- quizzes.mode: the GOL-12.3 diagnostic is a practice quiz in diagnostic mode ----
select lives_ok(
  $$insert into public.quizzes (owner_id, kind, mode, question_ids) values ('a1000000-0000-4000-8000-000000000001', 'practice', 'diagnostic', '{}')$$,
  'a diagnostic quiz is stored with mode diagnostic');

-- ---- battles.status: the worker uses reveal, and the schema keeps that value (not changed here) ----
select ok(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.battles'::regclass and pg_get_constraintdef(c.oid) like '%question_open%') like '%''reveal''%',
  'battles.status allows reveal');

select * from finish();
rollback;
