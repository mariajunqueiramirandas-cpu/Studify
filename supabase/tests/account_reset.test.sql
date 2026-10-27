-- private.reset_account: wipes what the student owns, keeps the login and profile identity, leaves Turma
-- content with the Turma, refuses a Turma owner, and is callable only by the service role.
begin;
select no_plan();

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@studify.test'),
  ('33333333-3333-4333-8333-333333333333', 'carol@studify.test'),
  ('55555555-5555-4555-8555-555555555555', 'erin@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, school_year, privacy_notice_version, privacy_accepted_at, app_role, settings, onboarding_completed_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2009, 3, 'em2', 'v1', now(), 'app_admin', '{"daily_goal_minutes": 40}', now()),
  ('33333333-3333-4333-8333-333333333333', 'Carol', 'approved', 2008, 8, 'em3', 'v1', now(), 'user', '{}', now()),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, null,  'v1', now(), 'user', '{}', now());

-- Turma A: Erin owns it; Alice is a member who approved Carol and created an invite.
insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at, approved_by) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',     'active', now(), null),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'moderator', 'active', now(), null),
  ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'member',    'active', now(), '11111111-1111-4111-8111-111111111111');
insert into public.invites (code, created_by, class_group_id) values
  ('BCDE2346', '11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777');

-- Alice's personal subject with a material, a topic, a card and its review history.
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf'),
  ('c0000000-0000-4000-8000-0000000000c1', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', 'Fisica', '#0000aa', 'atom');
insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'Resumo', 'notes', 'a0000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000001.pdf', 1000, repeat('a', 64));
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('40000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Unidade 1');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000000', 'topic', 'Celula');
insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by) values
  ('c1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'basic', 'Q', 'A', 'generated', '11111111-1111-4111-8111-111111111111');
insert into public.card_states (user_id, card_id, subject_id, due) values
  ('11111111-1111-4111-8111-111111111111', 'c1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', now());
insert into public.review_logs (id, user_id, card_id, rating, reviewed_at, client_reviewed_at) values
  ('e0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c1000000-0000-4000-8000-000000000001', 3, now(), now());
insert into public.goals (id, user_id, mode, name, start_date, end_date) values
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'exam_week', 'Provas', '2026-11-01', '2026-11-10');
insert into public.xp_events (id, user_id, amount, source_feature, ref_type, ref_id, occurred_at, local_date) values
  ('f0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 10, 'MEM-01', 'card', 'c1000000-0000-4000-8000-000000000001', now(), current_date);
insert into public.streaks (user_id) values ('11111111-1111-4111-8111-111111111111');
insert into public.data_exports (user_id, status, storage_path) values
  ('11111111-1111-4111-8111-111111111111', 'ready', '11111111-1111-4111-8111-111111111111/export.zip');

-- A Turma subject Alice created, with her note and her upload in it.
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'Matematica', '#aa0000', 'calc');
insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d2000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'Lista', 'notes', '50000000-0000-4000-8000-000000000001/d2000000-0000-4000-8000-000000000001.pdf', 1000, repeat('b', 64));
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('42000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Funcoes');
insert into public.notes (id, subject_id, node_id, depth, language, created_by) values
  ('a7000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'tldr', 'pt-BR', '11111111-1111-4111-8111-111111111111');

select test_helpers.check_err('a student cannot run the reset directly', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$select private.reset_account('11111111-1111-4111-8111-111111111111')$$);

select throws_ok($$select private.reset_account('55555555-5555-4555-8555-555555555555')$$,
  'P0001', 'owner_transfer_required', 'a Turma owner has to transfer the Turma first');

create temp table reset_out as select private.reset_account('11111111-1111-4111-8111-111111111111') as r;

select is((select r->'documents'->0->>'id' from reset_out), 'd1000000-0000-4000-8000-000000000001',
  'returns the personal materials whose files the worker removes');
select is((select jsonb_array_length(r->'documents') from reset_out), 1, 'Turma uploads are not in the removal list');
select is((select r->'exports'->>0 from reset_out), '11111111-1111-4111-8111-111111111111/export.zip', 'returns the export archives to remove');

-- The login and the profile identity stay; settings and onboarding start over.
select is((select count(*)::int from auth.users where id = '11111111-1111-4111-8111-111111111111'), 1, 'the login stays');
select is((select display_name || '|' || app_role || '|' || birth_year || '|' || school_year from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  'Alice|app_admin|2009|em2', 'name, role, birth year and school year stay (no new invite needed)');
select is((select settings from public.profiles where id = '11111111-1111-4111-8111-111111111111'), '{}'::jsonb, 'settings are back to defaults');
select is((select onboarding_completed_at from public.profiles where id = '11111111-1111-4111-8111-111111111111'), null, 'onboarding starts again');

-- Everything Alice owned is gone.
select is((select count(*)::int from public.subjects where owner_profile_id = '11111111-1111-4111-8111-111111111111'), 0, 'personal subjects are gone');
select is((select count(*)::int from public.documents where id = 'd1000000-0000-4000-8000-000000000001'), 0, 'personal materials are gone');
select is((select count(*)::int from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000001'), 0, 'their knowledge map is gone');
select is((select count(*)::int from public.cards where id = 'c1000000-0000-4000-8000-000000000001'), 0, 'their cards are gone');
select is((select count(*)::int from public.card_states where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'review schedule is gone');
select is((select count(*)::int from public.review_logs where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'review history is gone');
select is((select count(*)::int from public.goals where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'goals are gone');
select is((select count(*)::int from public.xp_events where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'XP is gone');
select is((select count(*)::int from public.streaks where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'the streak is gone');
select is((select count(*)::int from public.data_exports where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'export rows are gone');
select is((select count(*)::int from public.class_group_members where user_id = '11111111-1111-4111-8111-111111111111'), 0, 'she left the Turma');
select is((select count(*)::int from public.invites where created_by = '11111111-1111-4111-8111-111111111111'), 0, 'her invites are gone');

-- Turma content stays with the Turma.
select is((select created_by from public.subjects where id = '50000000-0000-4000-8000-000000000001'), '55555555-5555-4555-8555-555555555555'::uuid,
  'the Turma subject she created now belongs to the Turma owner');
select is((select created_by from public.notes where id = 'a7000000-0000-4000-8000-000000000001'), '55555555-5555-4555-8555-555555555555'::uuid,
  'her note in the Turma subject now belongs to the Turma owner');
select is((select count(*)::int from public.documents where id = 'd2000000-0000-4000-8000-000000000001'), 1, 'her upload to the Turma stays for the classmates');
select is((select approved_by from public.class_group_members where user_id = '33333333-3333-4333-8333-333333333333'), null, 'memberships she approved stay, without her as approver');

-- Other students are untouched.
select is((select count(*)::int from public.subjects where id = 'c0000000-0000-4000-8000-0000000000c1'), 1, 'other students keep their subjects');
select is((select settings from public.profiles where id = '33333333-3333-4333-8333-333333333333'), '{}'::jsonb, 'other profiles are untouched');

select * from finish();
rollback;
