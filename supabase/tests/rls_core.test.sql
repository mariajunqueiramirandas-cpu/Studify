-- RLS and RPC suite for the foundation schema (testing-strategy.md §4).
-- Personas: alice (owns a personal subject, Turma A member), bob (Turma A member),
-- carol (Turma A moderator), dave (outside Turma A, own subject), anon, service.
-- erin (Turma A owner, app admin) is added for owner-only and admin-only paths.
-- Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

create or replace function pg_temp.u(p text) returns uuid
language sql immutable as $$
  select case p
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob'   then '22222222-2222-4222-8222-222222222222'
    when 'carol' then '33333333-3333-4333-8333-333333333333'
    when 'dave'  then '44444444-4444-4444-8444-444444444444'
    when 'erin'  then '55555555-5555-4555-8555-555555555555'
  end::uuid
$$;

-- =====================================================================
-- Seed (superuser, bypasses RLS)
-- =====================================================================
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@studify.test'),
  ('22222222-2222-4222-8222-222222222222', 'bob@studify.test'),
  ('33333333-3333-4333-8333-333333333333', 'carol@studify.test'),
  ('44444444-4444-4444-8444-444444444444', 'dave@studify.test'),
  ('55555555-5555-4555-8555-555555555555', 'erin@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, app_role) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now(), 'user'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now(), 'user'),
  ('33333333-3333-4333-8333-333333333333', 'Carol', 'approved', 2008, 8, 'v1', now(), 'user'),
  ('44444444-4444-4444-8444-444444444444', 'Dave',  'pending',  2009, 2, 'v1', now(), 'user'),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, 'v1', now(), 'app_admin');

insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',     'active', now()),
  ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'moderator', 'active', now()),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'member',    'active', now()),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'member',    'active', now());
insert into public.invites (code, created_by, class_group_id) values
  ('ABCD2345', '55555555-5555-4555-8555-555555555555', '77777777-7777-4777-8777-777777777777');

insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf'),
  ('d0000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444', 'Quimica',  '#0000aa', 'flask');
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'Matematica', '#aa0000', 'calc');

insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333',
   'Lista 1', 'notes', 'documents/50000000/d1000000.pdf', 1000, repeat('a', 64));
insert into public.document_pages (document_id, page_number, text) values
  ('d1000000-0000-4000-8000-000000000001', 1, 'funcao afim e funcao quadratica');

insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Unidade 1');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao afim'),
  ('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao quadratica');
insert into public.node_sources (node_id, document_id, page_start, page_end, origin) values
  ('40000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 1, 1, 'ai');
insert into public.node_prerequisites (node_id, prerequisite_node_id, origin) values
  ('40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', 'ai');
insert into public.node_relations (subject_id, from_node_id, to_node_id, kind) values
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', 'related');
insert into public.node_events (subject_id, node_id, actor_id, action, payload) values
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'create', '{}');

insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by) values
  ('c0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'Q shared', 'A shared', 'generated', '33333333-3333-4333-8333-333333333333');
insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by, personal_for_user_id) values
  ('c0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'Q bob', 'A bob', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
insert into public.card_states (user_id, card_id, subject_id, due) values
  ('22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', now());
insert into public.review_logs (id, user_id, card_id, rating, reviewed_at, client_reviewed_at) values
  ('e0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-000000000001', 3, now(), now());

insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, review_status) values
  ('b1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Quanto e 1+1?', '{}', 'generated', 'approved');
insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, author_id, review_status) values
  ('b1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Pergunta de colega', '{}', 'peer', '22222222-2222-4222-8222-222222222222', 'pending');

insert into public.goals (id, user_id, mode, name, start_date, end_date) values
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'exam_week', 'Semana de provas', '2026-11-01', '2026-11-10');
insert into public.exams (id, goal_id, user_id, title, local_date) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Prova de biologia', '2026-11-05');
insert into public.plan_runs (id, user_id, version, trigger, input_hash) values
  ('a3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 1, 'goal_created', 'h1');
insert into public.plan_items (id, user_id, goal_id, plan_run_id, local_date, unit_type, minutes) values
  ('a4000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', '2026-10-28', 'learn', 30);

insert into public.ai_jobs (id, type, user_id, subject_id, status) values
  ('a5000000-0000-4000-8000-000000000001', 'ing.outline', '33333333-3333-4333-8333-333333333333', '50000000-0000-4000-8000-000000000001', 'queued'),
  ('a6000000-0000-4000-8000-000000000001', 'ing.outline', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'queued');
insert into public.ai_usage (user_id, class_group_id, subject_id, feature, task, model, cost_micro_usd, price_version) values
  ('11111111-1111-4111-8111-111111111111', null, 'a0000000-0000-4000-8000-000000000001', 'TUT-01', 'tutor.answer', 'claude-opus-5-5', 100, 'v1'),
  ('33333333-3333-4333-8333-333333333333', '77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001', 'ING-01', 'ing.outline', 'claude-opus-5-5', 500, 'v1');

insert into public.feature_flags (key, enabled_all) values ('enem_mode', true), ('secret_flag', false);
insert into public.app_versions (version_code, version_name, runtime_version) values (10, '1.0.0', '1');
insert into public.release_notes (version, items) values ('1.0.0', '["Primeira versao"]');
insert into public.data_exports (user_id, status) values ('11111111-1111-4111-8111-111111111111', 'queued');
insert into public.account_deletions (user_id, requested_by) values ('11111111-1111-4111-8111-111111111111', 'self');
insert into public.notification_log (user_id, type, channel, scheduled_for) values
  ('11111111-1111-4111-8111-111111111111', 'review_due', 'reviews', now());
insert into public.user_reports (id, reporter_id, reported_id, class_group_id, reason) values
  ('f1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 'spam');
insert into storage.objects (bucket_id, name, owner) values
  ('documents', '50000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001.pdf', '33333333-3333-4333-8333-333333333333');

-- =====================================================================
-- 0. Global: RLS is on for every table in public and private
-- =====================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p') and not c.relrowsecurity),
  0, 'every table in public and private has row level security enabled');

-- Later phases add tables; their suites (rls_phase3.test.sql, ...) assert their own counts.
select cmp_ok(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p')),
  '>=', 88, 'the foundation, Phase 1 and Phase 2 create 88 tables (81 public, 7 private)');

-- =====================================================================
-- 1. profiles and public views (data-model §4.1, §5.1, §6.2)
-- =====================================================================
select test_helpers.check_rows('alice reads her own profile', 'authenticated', pg_temp.u('alice'),
  $$select id from public.profiles$$, 1);
select test_helpers.check_rows('bob cannot read alice profile row directly', 'authenticated', pg_temp.u('bob'),
  $$select id from public.profiles where id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_rows('bob sees alice through profiles_public (shared Turma)', 'authenticated', pg_temp.u('bob'),
  $$select id from public.profiles_public where id = '11111111-1111-4111-8111-111111111111'$$, 1);
select test_helpers.check_rows('dave does not see alice through profiles_public', 'authenticated', pg_temp.u('dave'),
  $$select id from public.profiles_public where id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_rows('alice updates her display name', 'authenticated', pg_temp.u('alice'),
  $$update public.profiles set display_name = 'Alicia' where id = '11111111-1111-4111-8111-111111111111'$$, 1);
select is((select display_name_status from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  'pending', 'a display name change goes back to moderation');
select test_helpers.check_err('alice cannot grant herself app_admin', 'authenticated', pg_temp.u('alice'),
  $$update public.profiles set app_role = 'app_admin' where id = '11111111-1111-4111-8111-111111111111'$$);
select test_helpers.check_err('alice cannot change her birth year', 'authenticated', pg_temp.u('alice'),
  $$update public.profiles set birth_year = 1990 where id = '11111111-1111-4111-8111-111111111111'$$);
select test_helpers.check_err('clients cannot insert profiles', 'authenticated', pg_temp.u('alice'),
  $$insert into public.profiles (id, display_name, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values ('66666666-6666-4666-8666-666666666666', 'Eve', 2010, 1, 'v1', now())$$);
select test_helpers.check_err('anon cannot read profiles', 'anon', null, $$select id from public.profiles$$);

-- =====================================================================
-- 2. study_preferences (own; minors need an 8 h quiet window, PLT-05.3)
-- =====================================================================
select test_helpers.check_rows('alice creates her study preferences', 'authenticated', pg_temp.u('alice'),
  $$insert into public.study_preferences (user_id) values ('11111111-1111-4111-8111-111111111111')$$, 1);
select test_helpers.check_rows('bob cannot read alice study preferences', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.study_preferences$$, 0);
select test_helpers.check_err('alice (under 18) cannot shorten her quiet window below 8 h', 'authenticated', pg_temp.u('alice'),
  $$update public.study_preferences set quiet_end = '23:00' where user_id = '11111111-1111-4111-8111-111111111111'$$);
select test_helpers.check_err('bob cannot insert study preferences for alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.study_preferences (user_id) values ('11111111-1111-4111-8111-111111111111')$$);

-- =====================================================================
-- 3. invites (R23): creator and Turma moderators read; clients never write Turma codes
-- =====================================================================
select test_helpers.check_rows('erin (owner) reads the Turma invite', 'authenticated', pg_temp.u('erin'),
  $$select id from public.invites$$, 1);
select test_helpers.check_rows('carol (moderator) reads the Turma invite', 'authenticated', pg_temp.u('carol'),
  $$select id from public.invites$$, 1);
select test_helpers.check_rows('bob (member) cannot read the Turma invite', 'authenticated', pg_temp.u('bob'),
  $$select id from public.invites$$, 0);
select test_helpers.check_err('bob cannot create a pilot invite', 'authenticated', pg_temp.u('bob'),
  $$insert into public.invites (code, created_by) values ('ZZZZ2222', '22222222-2222-4222-8222-222222222222')$$);
select test_helpers.check_err('anon cannot read invites', 'anon', null, $$select id from public.invites$$);

-- =====================================================================
-- 4. class_groups, class_group_members, class_group_members_public (SOC-01)
-- =====================================================================
select test_helpers.check_rows('bob reads Turma A', 'authenticated', pg_temp.u('bob'),
  $$select id from public.class_groups$$, 1);
select test_helpers.check_rows('dave cannot read Turma A', 'authenticated', pg_temp.u('dave'),
  $$select id from public.class_groups$$, 0);
select test_helpers.check_rows('bob cannot rename Turma A', 'authenticated', pg_temp.u('bob'),
  $$update public.class_groups set name = 'Hack' where id = '77777777-7777-4777-8777-777777777777'$$, 0);
select test_helpers.check_err('a moderator cannot change the Turma AI budget (owner/service only)', 'authenticated', pg_temp.u('carol'),
  $$update public.class_groups set ai_budget_monthly_micro_usd = 1 where id = '77777777-7777-4777-8777-777777777777'$$);
select test_helpers.check_rows('carol (moderator) renames Turma A', 'authenticated', pg_temp.u('carol'),
  $$update public.class_groups set name = 'Turma A 2026' where id = '77777777-7777-4777-8777-777777777777'$$, 1);
select test_helpers.check_rows('bob sees only his own membership row', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.class_group_members where class_group_id = '77777777-7777-4777-8777-777777777777'$$, 1);
select test_helpers.check_rows('carol (moderator) sees all four memberships', 'authenticated', pg_temp.u('carol'),
  $$select user_id from public.class_group_members where class_group_id = '77777777-7777-4777-8777-777777777777'$$, 4);
select test_helpers.check_rows('dave sees no memberships of Turma A', 'authenticated', pg_temp.u('dave'),
  $$select user_id from public.class_group_members where class_group_id = '77777777-7777-4777-8777-777777777777'$$, 0);
select test_helpers.check_rows('bob sees the active roster through class_group_members_public', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.class_group_members_public where class_group_id = '77777777-7777-4777-8777-777777777777'$$, 4);
select test_helpers.check_rows('dave sees no roster', 'authenticated', pg_temp.u('dave'),
  $$select user_id from public.class_group_members_public where class_group_id = '77777777-7777-4777-8777-777777777777'$$, 0);
select test_helpers.check_rows('bob updates his own nickname', 'authenticated', pg_temp.u('bob'),
  $$update public.class_group_members set nickname = 'bobby' where class_group_id = '77777777-7777-4777-8777-777777777777' and user_id = '22222222-2222-4222-8222-222222222222'$$, 1);
select test_helpers.check_rows('bob cannot change carol membership', 'authenticated', pg_temp.u('bob'),
  $$update public.class_group_members set nickname = 'x' where user_id = '33333333-3333-4333-8333-333333333333'$$, 0);
select test_helpers.check_err('bob cannot ban himself by writing a status other than left', 'authenticated', pg_temp.u('bob'),
  $$update public.class_group_members set status = 'banned' where class_group_id = '77777777-7777-4777-8777-777777777777' and user_id = '22222222-2222-4222-8222-222222222222'$$);
select test_helpers.check_err('clients cannot insert memberships directly (use join_class_group)', 'authenticated', pg_temp.u('dave'),
  $$insert into public.class_group_members (class_group_id, user_id) values ('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444')$$);

-- =====================================================================
-- 5. subjects (personal vs shared, R8 / §6.3)
-- =====================================================================
select test_helpers.check_rows('alice reads her personal subject', 'authenticated', pg_temp.u('alice'),
  $$select id from public.subjects where id = 'a0000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob cannot read alice personal subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.subjects where id = 'a0000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('bob reads the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.subjects where id = '50000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('dave cannot read the Turma subject', 'authenticated', pg_temp.u('dave'),
  $$select id from public.subjects where id = '50000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('bob (member, not editor) cannot rename the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$update public.subjects set name = 'X' where id = '50000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('carol (creator and moderator) renames the Turma subject', 'authenticated', pg_temp.u('carol'),
  $$update public.subjects set name = 'Matematica 2' where id = '50000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('alice creates a personal subject', 'authenticated', pg_temp.u('alice'),
  $$insert into public.subjects (owner_profile_id, created_by, name, color, icon) values ('11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Historia', '#112233', 'book')$$, 1);
select test_helpers.check_err('alice cannot create a subject owned by bob', 'authenticated', pg_temp.u('alice'),
  $$insert into public.subjects (owner_profile_id, created_by, name, color, icon) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Fake', '#112233', 'book')$$);
select test_helpers.check_err('alice cannot move her subject into a Turma with a direct update', 'authenticated', pg_temp.u('alice'),
  $$update public.subjects set owner_class_group_id = '77777777-7777-4777-8777-777777777777', owner_profile_id = null where id = 'a0000000-0000-4000-8000-000000000001'$$);

-- =====================================================================
-- 6. documents, document_pages, document_slices (§4.2, §6.2, §7)
-- =====================================================================
select test_helpers.check_rows('bob reads the Turma document', 'authenticated', pg_temp.u('bob'),
  $$select id from public.documents$$, 1);
select test_helpers.check_rows('dave reads zero Turma A documents', 'authenticated', pg_temp.u('dave'),
  $$select id from public.documents where subject_id = '50000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('bob cannot upload to a subject that does not allow member uploads', 'authenticated', pg_temp.u('bob'),
  $$insert into public.documents (subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values ('50000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'X', 'notes', 'p', 1, repeat('b', 64))$$);
select test_helpers.check_rows('carol (moderator) uploads a document', 'authenticated', pg_temp.u('carol'),
  $$insert into public.documents (subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values ('50000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Lista 2', 'notes', 'p2', 1, repeat('b', 64))$$, 1);
select test_helpers.check_err('clients cannot insert a document already marked ready', 'authenticated', pg_temp.u('carol'),
  $$insert into public.documents (subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256, status) values ('50000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Lista 3', 'notes', 'p3', 1, repeat('c', 64), 'ready')$$);
select test_helpers.check_rows('bob cannot change the title of carol document', 'authenticated', pg_temp.u('bob'),
  $$update public.documents set title = 'Y' where id = 'd1000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('clients cannot hard delete documents', 'authenticated', pg_temp.u('carol'),
  $$delete from public.documents where id = 'd1000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob reads document pages of the Turma document', 'authenticated', pg_temp.u('bob'),
  $$select page_number from public.document_pages$$, 1);
select test_helpers.check_rows('dave reads no document pages', 'authenticated', pg_temp.u('dave'),
  $$select page_number from public.document_pages$$, 0);
select test_helpers.check_err('clients cannot write document pages', 'authenticated', pg_temp.u('carol'),
  $$insert into public.document_pages (document_id, page_number) values ('d1000000-0000-4000-8000-000000000001', 2)$$);
select test_helpers.check_err('clients cannot read document slices (service only)', 'authenticated', pg_temp.u('bob'),
  $$select id from document_slices$$);
select test_helpers.check_ok('service writes a document slice', 'service_role', null,
  $$insert into public.document_slices (document_id, purpose, page_start, page_end, storage_path, size_bytes, est_tokens) values ('d1000000-0000-4000-8000-000000000001', 'outline', 1, 1, 'slices/d1/1-1.pdf', 10, 5)$$);

-- =====================================================================
-- 7. knowledge map: nodes, sources, prerequisites, relations, per-user settings, events (§4.2, §6.2)
-- =====================================================================
select test_helpers.check_rows('bob reads the knowledge map of the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.knowledge_nodes$$, 3);
select test_helpers.check_rows('dave reads no knowledge nodes of Turma A', 'authenticated', pg_temp.u('dave'),
  $$select id from public.knowledge_nodes$$, 0);
select test_helpers.check_err('clients cannot edit nodes directly (use edit_outline)', 'authenticated', pg_temp.u('carol'),
  $$update public.knowledge_nodes set title = 'hack' where id = '40000000-0000-4000-8000-000000000002'$$);
select test_helpers.check_rows('bob reads node sources', 'authenticated', pg_temp.u('bob'),
  $$select id from public.node_sources$$, 1);
select test_helpers.check_rows('dave reads no node sources', 'authenticated', pg_temp.u('dave'),
  $$select id from public.node_sources$$, 0);
select test_helpers.check_err('clients cannot write node sources', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_sources (node_id, document_id, page_start, page_end, origin) values ('40000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', 1, 1, 'user')$$);
select test_helpers.check_rows('bob reads prerequisites', 'authenticated', pg_temp.u('bob'),
  $$select node_id from public.node_prerequisites$$, 1);
select test_helpers.check_rows('dave reads no prerequisites', 'authenticated', pg_temp.u('dave'),
  $$select node_id from public.node_prerequisites$$, 0);
select test_helpers.check_err('clients cannot write prerequisites', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_prerequisites (node_id, prerequisite_node_id, origin) values ('40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', 'user')$$);
select test_helpers.check_rows('bob reads node relations', 'authenticated', pg_temp.u('bob'),
  $$select id from public.node_relations$$, 1);
select test_helpers.check_rows('dave reads no node relations', 'authenticated', pg_temp.u('dave'),
  $$select id from public.node_relations$$, 0);
select test_helpers.check_err('clients cannot write node relations', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_relations (subject_id, from_node_id, to_node_id, kind) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', 'contrast')$$);
select test_helpers.check_rows('bob marks a topic as not on the exam (own row)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_user_settings (user_id, node_id, excluded) values ('22222222-2222-4222-8222-222222222222', '40000000-0000-4000-8000-000000000003', true)$$, 1);
select test_helpers.check_err('bob cannot write node settings for alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_user_settings (user_id, node_id, excluded) values ('11111111-1111-4111-8111-111111111111', '40000000-0000-4000-8000-000000000003', true)$$);
select test_helpers.check_rows('alice does not see bob node settings', 'authenticated', pg_temp.u('alice'),
  $$select node_id from public.node_user_settings$$, 0);
select test_helpers.check_rows('bob pins the Turma subject (own settings)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.subject_user_settings (user_id, subject_id, pinned) values ('22222222-2222-4222-8222-222222222222', '50000000-0000-4000-8000-000000000001', true)$$, 1);
select test_helpers.check_err('dave cannot pin a subject he cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.subject_user_settings (user_id, subject_id, pinned) values ('44444444-4444-4444-8444-444444444444', '50000000-0000-4000-8000-000000000001', true)$$);
select test_helpers.check_rows('bob reads Turma node events', 'authenticated', pg_temp.u('bob'),
  $$select id from public.node_events$$, 1);
select test_helpers.check_rows('dave reads no node events', 'authenticated', pg_temp.u('dave'),
  $$select id from public.node_events$$, 0);
select test_helpers.check_err('clients cannot write node events', 'authenticated', pg_temp.u('bob'),
  $$insert into public.node_events (subject_id, node_id, action) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', 'rename')$$);

-- =====================================================================
-- 8. cards, card_states, review_logs, questions (§4.3, §6.2, §6.3, R8)
-- =====================================================================
select test_helpers.check_rows('bob reads the shared card and his personal card', 'authenticated', pg_temp.u('bob'),
  $$select id from public.cards$$, 2);
select test_helpers.check_rows('alice cannot read bob personal card (R8)', 'authenticated', pg_temp.u('alice'),
  $$select id from public.cards where id = 'c0000000-0000-4000-8000-000000000002'$$, 0);
select test_helpers.check_rows('alice reads the shared card of the Turma subject', 'authenticated', pg_temp.u('alice'),
  $$select id from public.cards where id = 'c0000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('dave reads no cards of Turma A', 'authenticated', pg_temp.u('dave'),
  $$select id from public.cards$$, 0);
select test_helpers.check_rows('bob creates a personal card in the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$insert into public.cards (subject_id, node_id, type, front, back, origin, created_by, personal_for_user_id) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'f', 'b', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222')$$, 1);
select test_helpers.check_err('bob cannot create a card personal to alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.cards (subject_id, node_id, type, front, back, origin, created_by, personal_for_user_id) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'f', 'b', 'user', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_rows('bob edits his personal card', 'authenticated', pg_temp.u('bob'),
  $$update public.cards set front = 'Q bob 2' where id = 'c0000000-0000-4000-8000-000000000002'$$, 1);
select test_helpers.check_rows('bob cannot edit the shared card', 'authenticated', pg_temp.u('bob'),
  $$update public.cards set front = 'x' where id = 'c0000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('carol cannot edit the shared card (fixes go through TRU-02)', 'authenticated', pg_temp.u('carol'),
  $$update public.cards set front = 'x' where id = 'c0000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('clients cannot hard delete cards', 'authenticated', pg_temp.u('bob'),
  $$delete from public.cards where id = 'c0000000-0000-4000-8000-000000000002'$$);
select test_helpers.check_rows('bob reads his own card state', 'authenticated', pg_temp.u('bob'),
  $$select card_id from public.card_states$$, 1);
select test_helpers.check_rows('alice cannot read bob card state', 'authenticated', pg_temp.u('alice'),
  $$select card_id from public.card_states$$, 0);
select test_helpers.check_err('clients cannot write card states (sync-push replay only)', 'authenticated', pg_temp.u('bob'),
  $$update public.card_states set reps = 99 where user_id = '22222222-2222-4222-8222-222222222222'$$);
select test_helpers.check_rows('bob reads his own review log', 'authenticated', pg_temp.u('bob'),
  $$select id from public.review_logs$$, 1);
select test_helpers.check_rows('alice cannot read bob review log', 'authenticated', pg_temp.u('alice'),
  $$select id from public.review_logs$$, 0);
select test_helpers.check_err('clients cannot insert review logs directly (sync-push only)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.review_logs (id, user_id, card_id, rating, reviewed_at, client_reviewed_at) values ('e0000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-000000000001', 3, now(), now())$$);
select test_helpers.check_err('nobody can UPDATE review logs: the owner is refused', 'authenticated', pg_temp.u('bob'),
  $$update public.review_logs set rating = 4$$);
select test_helpers.check_err('nobody can DELETE review logs: the owner is refused', 'authenticated', pg_temp.u('bob'),
  $$delete from public.review_logs$$);
select test_helpers.check_err('nobody can UPDATE review logs: service role is refused by the append-only guard', 'service_role', null,
  $$update public.review_logs set rating = 4$$);
select test_helpers.check_err('nobody can DELETE review logs: service role is refused by the append-only guard', 'service_role', null,
  $$delete from public.review_logs$$);
select test_helpers.check_rows('bob reads the approved Turma question and his pending peer question', 'authenticated', pg_temp.u('bob'),
  $$select id from public.questions$$, 2);
select test_helpers.check_rows('alice (Turma member) sees bob pending peer question to vote on it (SOC-07.3)', 'authenticated', pg_temp.u('alice'),
  $$select id from public.questions where id = 'b1000000-0000-4000-8000-000000000002'$$, 1);
select test_helpers.check_rows('alice sees the approved Turma question', 'authenticated', pg_temp.u('alice'),
  $$select id from public.questions where id = 'b1000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('carol (moderator) sees the pending peer question', 'authenticated', pg_temp.u('carol'),
  $$select id from public.questions where id = 'b1000000-0000-4000-8000-000000000002'$$, 1);
select test_helpers.check_err('alice cannot publish a peer question as approved', 'authenticated', pg_temp.u('alice'),
  $$insert into public.questions (subject_id, node_id, type, stem, payload, origin, author_id, review_status) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'x', '{}', 'peer', '11111111-1111-4111-8111-111111111111', 'approved')$$);
select test_helpers.check_rows('alice submits a peer question as pending', 'authenticated', pg_temp.u('alice'),
  $$insert into public.questions (subject_id, node_id, type, stem, payload, origin, author_id, review_status) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Pergunta da Alice', '{}', 'peer', '11111111-1111-4111-8111-111111111111', 'pending')$$, 1);
select test_helpers.check_rows('bob keeps a personal question in the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$insert into public.questions (subject_id, node_id, type, stem, payload, origin, author_id, personal_for_user_id, review_status) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Minha pergunta', '{}', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'approved')$$, 1);
select test_helpers.check_rows('alice cannot edit the personal question of bob', 'authenticated', pg_temp.u('alice'),
  $$update public.questions set stem = 'x' where personal_for_user_id = '22222222-2222-4222-8222-222222222222'$$, 0);

-- =====================================================================
-- 9. goals, exams, plan_runs, plan_items (§4.4, §6.2)
-- =====================================================================
select test_helpers.check_rows('alice reads her goal', 'authenticated', pg_temp.u('alice'),
  $$select id from public.goals$$, 1);
select test_helpers.check_rows('bob cannot read alice goal', 'authenticated', pg_temp.u('bob'),
  $$select id from public.goals$$, 0);
select test_helpers.check_rows('alice creates a goal', 'authenticated', pg_temp.u('alice'),
  $$insert into public.goals (user_id, mode, name, start_date, end_date) values ('11111111-1111-4111-8111-111111111111', 'enem', 'ENEM', '2026-11-01', '2026-11-30')$$, 1);
select test_helpers.check_err('bob cannot create a goal for alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.goals (user_id, mode, name, start_date, end_date) values ('11111111-1111-4111-8111-111111111111', 'enem', 'Fake', '2026-11-01', '2026-11-30')$$);
select test_helpers.check_rows('alice adds an exam to her goal', 'authenticated', pg_temp.u('alice'),
  $$insert into public.exams (goal_id, user_id, title, local_date) values ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Prova de quimica', '2026-11-08')$$, 1);
select test_helpers.check_err('bob cannot add an exam to alice goal', 'authenticated', pg_temp.u('bob'),
  $$insert into public.exams (goal_id, user_id, title, local_date) values ('a1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Fake', '2026-11-08')$$);
select test_helpers.check_err('alice cannot set scope_status directly (confirm_exam_scope only)', 'authenticated', pg_temp.u('alice'),
  $$update public.exams set scope_status = 'confirmed' where id = 'a2000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('clients cannot write plan runs', 'authenticated', pg_temp.u('alice'),
  $$insert into public.plan_runs (user_id, version, trigger, input_hash) values ('11111111-1111-4111-8111-111111111111', 2, 'nightly', 'h2')$$);
select test_helpers.check_rows('bob cannot read alice plan runs', 'authenticated', pg_temp.u('bob'),
  $$select id from public.plan_runs$$, 0);
select test_helpers.check_rows('alice marks a plan item done', 'authenticated', pg_temp.u('alice'),
  $$update public.plan_items set status = 'done' where id = 'a4000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot change the minutes of a plan item', 'authenticated', pg_temp.u('alice'),
  $$update public.plan_items set minutes = 5 where id = 'a4000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob cannot touch alice plan item', 'authenticated', pg_temp.u('bob'),
  $$update public.plan_items set status = 'skipped' where id = 'a4000000-0000-4000-8000-000000000001'$$, 0);

-- =====================================================================
-- 10. ai_jobs, ai_usage, private budgets (§5.11, PLT-04, §6.2)
-- =====================================================================
select test_helpers.check_rows('alice reads her own job', 'authenticated', pg_temp.u('alice'),
  $$select id from public.ai_jobs where id = 'a6000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob reads the job of the shared Turma subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.ai_jobs where id = 'a5000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('dave reads no Turma job', 'authenticated', pg_temp.u('dave'),
  $$select id from public.ai_jobs where id = 'a5000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('clients cannot create jobs (Edge/worker only)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.ai_jobs (type, user_id) values ('ing.outline', '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_rows('alice reads her own AI usage', 'authenticated', pg_temp.u('alice'),
  $$select id from public.ai_usage$$, 1);
select test_helpers.check_rows('bob reads no AI usage rows of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.ai_usage$$, 0);
select test_helpers.check_err('clients cannot insert AI usage', 'authenticated', pg_temp.u('alice'),
  $$insert into public.ai_usage (user_id, feature, task, model, cost_micro_usd, price_version) values ('11111111-1111-4111-8111-111111111111', 'TUT-01', 't', 'm', 1, 'v1')$$);
select test_helpers.check_ok('service inserts AI usage', 'service_role', null,
  $$insert into public.ai_usage (user_id, feature, task, model, cost_micro_usd, price_version) values ('11111111-1111-4111-8111-111111111111', 'TUT-02', 't', 'm', 2, 'v1')$$);
select test_helpers.check_err('AI usage is append-only: service role UPDATE is refused', 'service_role', null,
  $$update public.ai_usage set cost_micro_usd = 0$$);
select test_helpers.check_err('private budgets are not readable by clients', 'authenticated', pg_temp.u('alice'),
  $$select 1 from private.ai_budgets$$);
select test_helpers.check_err('private moderation log is not readable by clients', 'authenticated', pg_temp.u('erin'),
  $$select 1 from private.moderation_actions$$);
select test_helpers.check_ok('service reads private budgets', 'service_role', null,
  $$select 1 from private.ai_budgets$$);

-- =====================================================================
-- 11. platform tables (§5.1, §5.11, §6.2)
-- =====================================================================
select test_helpers.check_scalar('the enabled feature flag is returned for alice', 'authenticated', pg_temp.u('alice'),
  $$'enem_mode' = any(public.my_feature_flags())$$, 'true');
select test_helpers.check_scalar('a disabled feature flag is not returned', 'authenticated', pg_temp.u('alice'),
  $$'secret_flag' = any(public.my_feature_flags())$$, 'false');
select test_helpers.check_err('clients cannot read feature_flags directly', 'authenticated', pg_temp.u('alice'),
  $$select key from public.feature_flags$$);
select test_helpers.check_rows('any signed-in user reads app versions', 'authenticated', pg_temp.u('dave'),
  $$select version_code from public.app_versions$$, 1);
select test_helpers.check_err('anon cannot read app versions', 'anon', null,
  $$select version_code from public.app_versions$$);
select test_helpers.check_rows('any signed-in user reads release notes', 'authenticated', pg_temp.u('dave'),
  $$select version from public.release_notes$$, 1);
select test_helpers.check_err('clients cannot write release notes', 'authenticated', pg_temp.u('erin'),
  $$insert into public.release_notes (version) values ('9.9.9')$$);
select test_helpers.check_rows('alice files app feedback for herself', 'authenticated', pg_temp.u('alice'),
  $$insert into public.app_feedback (user_id, text) values ('11111111-1111-4111-8111-111111111111', 'Bom app')$$, 1);
select test_helpers.check_rows('alice cannot read app feedback (app admins only)', 'authenticated', pg_temp.u('alice'),
  $$select id from public.app_feedback$$, 0);
select test_helpers.check_rows('erin (app admin) reads app feedback', 'authenticated', pg_temp.u('erin'),
  $$select id from public.app_feedback$$, 1);
select test_helpers.check_rows('alice reads her data export', 'authenticated', pg_temp.u('alice'),
  $$select id from public.data_exports$$, 1);
select test_helpers.check_rows('bob reads no data exports of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.data_exports$$, 0);
select test_helpers.check_err('clients cannot request data exports directly (Edge only)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.data_exports (user_id) values ('11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_rows('alice reads her account deletion record', 'authenticated', pg_temp.u('alice'),
  $$select id from public.account_deletions$$, 1);
select test_helpers.check_err('clients cannot write account deletions', 'authenticated', pg_temp.u('alice'),
  $$update public.account_deletions set status = 'done'$$);
select test_helpers.check_rows('alice reads her notification log', 'authenticated', pg_temp.u('alice'),
  $$select id from public.notification_log$$, 1);
select test_helpers.check_err('clients cannot write the notification log', 'authenticated', pg_temp.u('alice'),
  $$insert into public.notification_log (user_id, type, channel, scheduled_for) values ('11111111-1111-4111-8111-111111111111', 'x', 'reviews', now())$$);
select test_helpers.check_rows('alice registers a push token', 'authenticated', pg_temp.u('alice'),
  $$insert into public.push_tokens (user_id, token, device_id) values ('11111111-1111-4111-8111-111111111111', 'ExponentPushToken[abc]', 'dev-1')$$, 1);
select test_helpers.check_rows('bob cannot see alice push tokens', 'authenticated', pg_temp.u('bob'),
  $$select id from public.push_tokens$$, 0);
select test_helpers.check_rows('bob cannot change alice push tokens', 'authenticated', pg_temp.u('bob'),
  $$update public.push_tokens set app_version = '9'$$, 0);
select test_helpers.check_rows('bob blocks dave (own row)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.user_blocks (blocker_id, blocked_id) values ('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444')$$, 1);
select test_helpers.check_err('bob cannot block on behalf of alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.user_blocks (blocker_id, blocked_id) values ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444')$$);
select test_helpers.check_rows('alice cannot see the blocks of bob', 'authenticated', pg_temp.u('alice'),
  $$select blocker_id from public.user_blocks$$, 0);
select test_helpers.check_rows('bob reads his block list', 'authenticated', pg_temp.u('bob'),
  $$select blocked_id from public.user_blocks$$, 1);
select test_helpers.check_err('dave cannot report a member of a Turma he is not in', 'authenticated', pg_temp.u('dave'),
  $$insert into public.user_reports (reporter_id, reported_id, class_group_id, reason) values ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 'spam')$$);
select test_helpers.check_ok('bob reports alice in Turma A', 'authenticated', pg_temp.u('bob'),
  $$insert into public.user_reports (reporter_id, reported_id, class_group_id, reason) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 'harassment')$$);
select test_helpers.check_rows('carol (moderator) reads the reports of Turma A', 'authenticated', pg_temp.u('carol'),
  $$select id from public.user_reports$$, 2);
select test_helpers.check_rows('alice cannot read reports about herself', 'authenticated', pg_temp.u('alice'),
  $$select id from public.user_reports$$, 0);
select test_helpers.check_err('bob cannot change the status of a report (RPC only)', 'authenticated', pg_temp.u('bob'),
  $$update public.user_reports set status = 'dismissed'$$);

-- =====================================================================
-- 12. storage (§7): buckets exist and object policies follow the path rules
-- =====================================================================
select is((select count(*)::int from storage.buckets), 10, 'ten storage buckets are created');
select test_helpers.check_rows('bob reads the Turma document object', 'authenticated', pg_temp.u('bob'),
  $$select name from storage.objects where bucket_id = 'documents'$$, 1);
select test_helpers.check_rows('dave reads no Turma document object', 'authenticated', pg_temp.u('dave'),
  $$select name from storage.objects where bucket_id = 'documents'$$, 0);
select test_helpers.check_err('bob cannot upload into the Turma documents bucket', 'authenticated', pg_temp.u('bob'),
  $$insert into storage.objects (bucket_id, name) values ('documents', '50000000-0000-4000-8000-000000000001/x.pdf')$$);
select test_helpers.check_ok('carol uploads into the Turma documents bucket', 'authenticated', pg_temp.u('carol'),
  $$insert into storage.objects (bucket_id, name) values ('documents', '50000000-0000-4000-8000-000000000001/y.pdf')$$);
select test_helpers.check_err('clients cannot write slices bucket objects', 'authenticated', pg_temp.u('carol'),
  $$insert into storage.objects (bucket_id, name) values ('slices', 'd1/1-1.pdf')$$);
select test_helpers.check_ok('alice writes her own photo folder', 'authenticated', pg_temp.u('alice'),
  $$insert into storage.objects (bucket_id, name) values ('photos', '11111111-1111-4111-8111-111111111111/d/1.jpg')$$);
select test_helpers.check_err('bob cannot write alice photo folder', 'authenticated', pg_temp.u('bob'),
  $$insert into storage.objects (bucket_id, name) values ('photos', '11111111-1111-4111-8111-111111111111/d/2.jpg')$$);

-- =====================================================================
-- 13. RPCs (api.md §5). Ordered so that state changes come after the reads above.
-- =====================================================================
select test_helpers.check_scalar('create_class_group returns an 8-character invite code', 'authenticated', pg_temp.u('dave'),
  $$length((public.create_class_group('Turma B')->>'invite_code'))$$, '8');
select test_helpers.check_err('join_class_group rejects an unknown code', 'authenticated', pg_temp.u('dave'),
  $$select public.join_class_group('ZZZZZZZZ')$$);
select test_helpers.check_scalar('dave joins Turma A with the code and waits for approval', 'authenticated', pg_temp.u('dave'),
  $$public.join_class_group('ABCD2345')->>'status'$$, 'pending');
select test_helpers.check_err('bob cannot approve dave', 'authenticated', pg_temp.u('bob'),
  $$select public.moderate_member('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'approve')$$);
select test_helpers.check_ok('carol approves dave', 'authenticated', pg_temp.u('carol'),
  $$select public.moderate_member('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'approve')$$);
select test_helpers.check_scalar('dave is now an active member', 'authenticated', pg_temp.u('dave'),
  $$(select status from public.class_group_members where user_id = '44444444-4444-4444-8444-444444444444' and class_group_id = '77777777-7777-4777-8777-777777777777')$$, 'active');
select test_helpers.check_err('carol cannot ban the owner', 'authenticated', pg_temp.u('carol'),
  $$select public.moderate_member('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'ban')$$);
select test_helpers.check_ok('carol bans bob (logged to the moderation trail)', 'authenticated', pg_temp.u('carol'),
  $$select public.moderate_member('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'ban')$$);
select is((select count(*)::int from private.moderation_actions where action = 'ban' and target_id = '22222222-2222-4222-8222-222222222222'),
  1, 'the ban is written to private.moderation_actions');
select test_helpers.check_ok('erin rotates the Turma invite (revokes the old link)', 'authenticated', pg_temp.u('erin'),
  $$select public.rotate_invite('77777777-7777-4777-8777-777777777777', 7, null)$$);
select is((select count(*)::int from public.invites where class_group_id = '77777777-7777-4777-8777-777777777777' and revoked_at is null),
  1, 'exactly one live invite remains for Turma A after rotation');
select test_helpers.check_err('bob cannot create a shared subject (no upload rights)', 'authenticated', pg_temp.u('bob'),
  $$select public.create_shared_subject('77777777-7777-4777-8777-777777777777', 'Fisica', '#abcdef', 'atom')$$);
select test_helpers.check_ok('carol creates a shared subject', 'authenticated', pg_temp.u('carol'),
  $$select public.create_shared_subject('77777777-7777-4777-8777-777777777777', 'Fisica', '#abcdef', 'atom')$$);
select test_helpers.check_err('bob cannot edit the outline of the Turma subject', 'authenticated', pg_temp.u('bob'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"rename","node_id":"40000000-0000-4000-8000-000000000001","title":"X"}]'::jsonb)$$);
select test_helpers.check_err('merge is not supported by edit_outline yet', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"merge"}]'::jsonb)$$);
select test_helpers.check_ok('carol renames a unit through edit_outline', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"rename","node_id":"40000000-0000-4000-8000-000000000001","title":"Unidade 1 (nova)"}]'::jsonb)$$);
select is((select title from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000001'),
  'Unidade 1 (nova)', 'the rename is applied');
select test_helpers.check_ok('carol undoes that rename within 30 days', 'authenticated', pg_temp.u('carol'),
  $$select public.undo_outline_event((public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"rename","node_id":"40000000-0000-4000-8000-000000000002","title":"Afim (tmp)"}]'::jsonb)->'event_ids'->>0)::uuid)$$);
select is((select title from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000002'),
  'Funcao afim', 'undo restores the previous title');
select test_helpers.check_ok('alice leaves Turma A (not the owner)', 'authenticated', pg_temp.u('alice'),
  $$select public.leave_class_group('77777777-7777-4777-8777-777777777777')$$);
select test_helpers.check_err('the owner cannot leave without transferring ownership', 'authenticated', pg_temp.u('erin'),
  $$select public.leave_class_group('77777777-7777-4777-8777-777777777777')$$);
select test_helpers.check_ok('carol (moderator) reads AI spend of Turma A', 'authenticated', pg_temp.u('carol'),
  $$select public.class_group_ai_usage('77777777-7777-4777-8777-777777777777', (now() at time zone 'America/Sao_Paulo')::date)$$);
select test_helpers.check_err('bob cannot read AI spend of Turma A', 'authenticated', pg_temp.u('bob'),
  $$select public.class_group_ai_usage('77777777-7777-4777-8777-777777777777', (now() at time zone 'America/Sao_Paulo')::date)$$);
select test_helpers.check_scalar('AI spend by feature sums the Turma usage', 'authenticated', pg_temp.u('carol'),
  $$(public.class_group_ai_usage('77777777-7777-4777-8777-777777777777', (now() at time zone 'America/Sao_Paulo')::date)->'by_feature'->>'ING-01')$$, '500');
select test_helpers.check_err('clients cannot reserve AI budget', 'authenticated', pg_temp.u('alice'),
  $$select private.ai_budget_reserve('11111111-1111-4111-8111-111111111111', null, 'TUT-01', 'user', 1)$$);
select test_helpers.check_ok('service reserves and settles an AI call within budget', 'service_role', null,
  $$select private.ai_budget_settle(private.ai_budget_reserve('11111111-1111-4111-8111-111111111111', null, 'TUT-01', 'user', 100000), 50000)$$);
select is((select coalesce(sum(spent_micro_usd), 0)::int from private.ai_budgets where scope_type = 'user' and scope_id = '11111111-1111-4111-8111-111111111111'),
  50000, 'settlement records the actual cost on the user budget');
select test_helpers.check_err('a call over the daily user budget is refused (budget_exhausted)', 'service_role', null,
  $$select private.ai_budget_reserve('11111111-1111-4111-8111-111111111111', null, 'TUT-01', 'user', 2000000)$$);
select is((select coalesce(sum(reserved_micro_usd), 0)::int from private.ai_budgets where scope_type = 'user' and scope_id = '11111111-1111-4111-8111-111111111111'),
  0, 'a refused reservation holds nothing');
select test_helpers.check_ok('carol blocks dave through block_user', 'authenticated', pg_temp.u('carol'),
  $$select public.block_user('44444444-4444-4444-8444-444444444444')$$);
select test_helpers.check_err('a user cannot block themselves', 'authenticated', pg_temp.u('carol'),
  $$select public.block_user('33333333-3333-4333-8333-333333333333')$$);
select test_helpers.check_ok('carol handles the report: warn', 'authenticated', pg_temp.u('carol'),
  $$select public.handle_report('f1000000-0000-4000-8000-000000000001', 'warn')$$);
select test_helpers.check_err('bob cannot handle a report', 'authenticated', pg_temp.u('bob'),
  $$select public.handle_report('f1000000-0000-4000-8000-000000000001', 'dismiss')$$);
select test_helpers.check_err('handle_report refuses unsupported actions yet (remove_content)', 'authenticated', pg_temp.u('carol'),
  $$select public.handle_report('f1000000-0000-4000-8000-000000000001', 'remove_content')$$);

-- =====================================================================
-- 14. Last: soft delete is an UPDATE of deleted_at, and is the only way to delete
-- =====================================================================
select test_helpers.check_rows('carol soft-deletes the Turma document (tombstone)', 'authenticated', pg_temp.u('carol'),
  $$update public.documents set deleted_at = now() where id = 'd1000000-0000-4000-8000-000000000001'$$, 1);

select * from finish();
rollback;
