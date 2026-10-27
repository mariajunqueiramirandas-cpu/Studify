-- RLS, constraint and RPC suite for the Phase 5 tables (data-model.md §5.2 material_findings, §5.3 visuals,
-- mnemonics, memory_palaces, §5.5 performance_windows, §5.7 divide_plans, contributions, question_votes,
-- league_entries, §5.9 boss_attempts, retrospectives, nudge_events; §6.2).
-- Personas: alice, bob and cris (Turma A members), erin (Turma A owner), dave (outside Turma A).
-- Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

create or replace function pg_temp.u(p text) returns uuid
language sql immutable as $$
  select case p
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob'   then '22222222-2222-4222-8222-222222222222'
    when 'cris'  then '33333333-3333-4333-8333-333333333333'
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
  ('33333333-3333-4333-8333-333333333333', 'cris@studify.test'),
  ('44444444-4444-4444-8444-444444444444', 'dave@studify.test'),
  ('55555555-5555-4555-8555-555555555555', 'erin@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now()),
  ('33333333-3333-4333-8333-333333333333', 'Cris',  'approved', 2009, 7, 'v1', now()),
  ('44444444-4444-4444-8444-444444444444', 'Dave',  'approved', 2009, 2, 'v1', now()),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, 'v1', now());

insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at, nickname, league_opt_in) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',  'active', now(), 'Erin', false),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'member', 'active', now(), 'Ali', true),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'member', 'active', now(), 'Bob', true),
  ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'member', 'active', now(), 'Cris', false);

-- Biologia (alice, personal) and Matematica (Turma A).
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf');
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'Matematica', '#aa0000', 'calc');

insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Celulas'),
  ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Funcoes');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'topic', 'Mitose'),
  ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao afim'),
  ('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao quadratica'),
  ('40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Exponencial'),
  ('40000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Logaritmo');

insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Slides', 'notes', 'p1', 1, repeat('a', 64)),
  ('d1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'Apostila', 'notes', 'p2', 1, repeat('b', 64));

insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'basic', 'Fases da mitose', 'PMAT', 'generated', '11111111-1111-4111-8111-111111111111');

insert into public.visuals (id, subject_id, node_id, type, title, spec, alt_text) values
  ('f1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'cycle', 'Mitose', '{"nodes":[]}', 'Ciclo'),
  ('f1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'flowchart', 'Afim', '{"nodes":[]}', 'Fluxo');

insert into public.material_findings (id, document_id, subject_id, node_id, type, severity, page_start, page_end, description) values
  ('f2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'numeric_or_formula_typo', 'medium', 3, 3, 'Possível erro de número'),
  ('f2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'contradiction', 'high', 4, 9, 'A p. 4 contradiz a p. 9');

-- A pending peer question by bob, and a rejected one by cris.
insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, author_id, review_status) values
  ('b1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'true_false', 'f(x) = 2x é afim?', '{"statement":"x","correct":true}', 'peer', '22222222-2222-4222-8222-222222222222', 'pending'),
  ('b1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'true_false', 'Rejeitada', '{"statement":"x","correct":true}', 'peer', '33333333-3333-4333-8333-333333333333', 'rejected');

-- A divisão on Matematica (erin), with alice holding one topic.
insert into public.divide_plans (id, class_group_id, subject_id, title, node_ids, assignments, max_claims, created_by) values
  ('d2000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001', 'P1 de Mat',
   '{40000000-0000-4000-8000-000000000002,40000000-0000-4000-8000-000000000003,40000000-0000-4000-8000-000000000004,40000000-0000-4000-8000-000000000005}',
   '{"40000000-0000-4000-8000-000000000002":"11111111-1111-4111-8111-111111111111"}', 2, '55555555-5555-4555-8555-555555555555');

-- A boss quiz attempt (alice), XP for the league, a goal for the Retrospectiva.
insert into public.quizzes (id, owner_id, subject_id, kind, mode, question_ids) values
  ('a8000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'boss', 'exam_conditions', '{}');
insert into public.quiz_attempts (id, user_id, quiz_id, status, started_at, device_id) values
  ('a9000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a8000000-0000-4000-8000-000000000001', 'submitted', now(), 'dev-a');
insert into public.boss_attempts (id, user_id, unit_node_id, quiz_attempt_id, passed, score) values
  ('f3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', true, 0.8);

insert into public.xp_events (id, user_id, amount, source_feature, ref_type, ref_id, occurred_at, local_date, in_quiet_hours)
select gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 50, 'MOT-01', 'test', gen_random_uuid(),
       now() - interval '1 minute' * g, (now() at time zone 'America/Sao_Paulo')::date, false
  from generate_series(1, 12) g;                                                     -- 600 XP today → capped at 500
insert into public.xp_events (id, user_id, amount, source_feature, ref_type, ref_id, occurred_at, local_date, in_quiet_hours) values
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 40, 'MOT-01', 'test', gen_random_uuid(), now(), (now() at time zone 'America/Sao_Paulo')::date, false),
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 50, 'MOT-01', 'test', gen_random_uuid(), now(), (now() at time zone 'America/Sao_Paulo')::date, true);

insert into public.goals (id, user_id, mode, name, start_date, end_date) values
  ('60000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'exam_week', 'Provas', '2026-10-01', '2026-12-01');
insert into public.retrospectives (id, user_id, period_type, goal_id, period_start, period_end, stats, title) values
  ('f4000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'goal', '60000000-0000-4000-8000-000000000001', '2026-10-01', '2026-12-01', '{"active_minutes":600}', 'Que semana!');

insert into public.performance_windows (user_id, bucket, n_events, mean_residual, good) values
  ('11111111-1111-4111-8111-111111111111', 4, 320, 0.05, true);

-- =====================================================================
-- 1. RLS is enabled on every Phase 5 table
-- =====================================================================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
              and c.relname in ('visuals','material_findings','material_finding_votes','memory_palaces','mnemonics',
                                'performance_windows','divide_plans','contributions','question_votes','league_entries',
                                'boss_attempts','retrospectives','nudge_events')),
  13, 'Phase 5 creates 13 public tables, all with RLS');

-- =====================================================================
-- 2. visuals (LRN-05.5): readable with the subject, written by the server
-- =====================================================================
select test_helpers.check_rows('alice reads the visuals of both her subjects', 'authenticated', pg_temp.u('alice'),
  $$select id from public.visuals$$, 2);
select test_helpers.check_rows('bob reads only the shared Matematica visual', 'authenticated', pg_temp.u('bob'),
  $$select id from public.visuals$$, 1);
select test_helpers.check_rows('dave reads no visual', 'authenticated', pg_temp.u('dave'),
  $$select id from public.visuals$$, 0);
select test_helpers.check_err('clients cannot write visuals (visual-generate does)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.visuals (subject_id, node_id, type) values ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'timeline')$$);
select test_helpers.check_sqlstate('one visual per topic and type (LRN-05.5 cache)',
  $$insert into public.visuals (subject_id, node_id, type) values ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'cycle')$$, '23505');
select test_helpers.check_sqlstate('an unknown visual type is rejected',
  $$insert into public.visuals (subject_id, node_id, type) values ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'mindmap')$$, '23514');

-- =====================================================================
-- 3. material_findings (ING-06.3): votes through the RPC only
-- =====================================================================
select test_helpers.check_rows('bob sees the Turma finding, not alice''s personal one', 'authenticated', pg_temp.u('bob'),
  $$select id from public.material_findings$$, 1);
select test_helpers.check_err('clients cannot change a finding status directly', 'authenticated', pg_temp.u('alice'),
  $$update public.material_findings set status = 'dismissed' where id = 'f2000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('clients cannot insert votes directly', 'authenticated', pg_temp.u('alice'),
  $$insert into public.material_finding_votes (finding_id, user_id, vote) values ('f2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'is_error')$$);
select test_helpers.check_scalar('alice dismisses her personal finding with one vote', 'authenticated', pg_temp.u('alice'),
  $$(select status from public.vote_material_finding('f2000000-0000-4000-8000-000000000001', 'not_error'))$$, 'dismissed');
select test_helpers.check_scalar('one confirmation in a Turma subject keeps the finding open', 'authenticated', pg_temp.u('alice'),
  $$(select status from public.vote_material_finding('f2000000-0000-4000-8000-000000000002', 'is_error'))$$, 'open');
select test_helpers.check_scalar('a second member confirms it (ING-06.3: ≥ 2 confirmations)', 'authenticated', pg_temp.u('bob'),
  $$(select status from public.vote_material_finding('f2000000-0000-4000-8000-000000000002', 'is_error'))$$, 'confirmed');
select test_helpers.check_scalar('changing a vote recounts', 'authenticated', pg_temp.u('bob'),
  $$(select confirmations::text || '/' || dismissals::text from public.vote_material_finding('f2000000-0000-4000-8000-000000000002', 'not_error'))$$, '1/1');
select test_helpers.check_err('dave cannot vote on a finding he cannot read', 'authenticated', pg_temp.u('dave'),
  $$select * from public.vote_material_finding('f2000000-0000-4000-8000-000000000002', 'is_error')$$);
select test_helpers.check_rows('votes are private to their author', 'authenticated', pg_temp.u('alice'),
  $$select finding_id from public.material_finding_votes$$, 2);
select test_helpers.check_sqlstate('page_end cannot precede page_start',
  $$insert into public.material_findings (document_id, subject_id, type, severity, page_start, page_end, description)
    values ('d1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unclear', 'low', 5, 4, 'x')$$, '23514');

-- =====================================================================
-- 4. mnemonics and memory_palaces (MEM-06): own rows only
-- =====================================================================
select test_helpers.check_ok('alice creates a palace', 'authenticated', pg_temp.u('alice'),
  $$insert into public.memory_palaces (id, user_id, name, loci) values ('f5000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Minha casa', '["portão","sala","cozinha"]')$$);
select test_helpers.check_sqlstate('a palace holds at most 20 loci (MEM-06.5)',
  $$insert into public.memory_palaces (user_id, name, loci) select '11111111-1111-4111-8111-111111111111', 'Grande', jsonb_agg(g) from generate_series(1, 21) g$$, '23514');
select test_helpers.check_ok('alice attaches an acronym to her card', 'authenticated', pg_temp.u('alice'),
  $$insert into public.mnemonics (id, user_id, card_id, type, title, content) values ('f6000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'acronym', 'PMAT', '{"text":"PMAT"}')$$);
select test_helpers.check_err('one mnemonic per card for each user (MEM-06.4)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.mnemonics (user_id, card_id, type, title, content) values ('11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'rhyme', 'Rima', '{"text":"x"}')$$);
select test_helpers.check_err('bob cannot attach a mnemonic to a card he cannot read', 'authenticated', pg_temp.u('bob'),
  $$insert into public.mnemonics (user_id, card_id, type, title, content) values ('22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-000000000001', 'acronym', 'X', '{"text":"x"}')$$);
select test_helpers.check_err('bob cannot use alice''s palace', 'authenticated', pg_temp.u('bob'),
  $$insert into public.mnemonics (user_id, node_id, type, title, content, palace_id) values ('22222222-2222-4222-8222-222222222222', '40000000-0000-4000-8000-000000000002', 'palace', 'X', '{"text":"x"}', 'f5000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_sqlstate('a palace mnemonic needs a palace',
  $$insert into public.mnemonics (user_id, node_id, type, title, content) values ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002', 'palace', 'X', '{"text":"x"}')$$, '23514');
select test_helpers.check_rows('bob reads no one else''s mnemonics', 'authenticated', pg_temp.u('bob'),
  $$select id from public.mnemonics$$, 0);
select test_helpers.check_rows('alice edits her mnemonic', 'authenticated', pg_temp.u('alice'),
  $$update public.mnemonics set title = 'Pró-Meta-Ana-Telo' where id = 'f6000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob cannot edit alice''s mnemonic', 'authenticated', pg_temp.u('bob'),
  $$update public.mnemonics set title = 'x' where id = 'f6000000-0000-4000-8000-000000000001'$$, 0);

-- =====================================================================
-- 5. divide_plans and contributions (SOC-06)
-- =====================================================================
select test_helpers.check_rows('a member sees the divisão', 'authenticated', pg_temp.u('cris'),
  $$select id from public.divide_plans$$, 1);
select test_helpers.check_rows('an outsider does not', 'authenticated', pg_temp.u('dave'),
  $$select id from public.divide_plans$$, 0);
select test_helpers.check_ok('bob opens a divisão on a Turma subject', 'authenticated', pg_temp.u('bob'),
  $$insert into public.divide_plans (class_group_id, subject_id, title, node_ids, created_by) values ('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001', 'Lista', '{40000000-0000-4000-8000-000000000003}', '22222222-2222-4222-8222-222222222222')$$);
select test_helpers.check_err('a divisão cannot list topics of another subject', 'authenticated', pg_temp.u('bob'),
  $$insert into public.divide_plans (class_group_id, subject_id, title, node_ids, created_by) values ('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001', 'X', '{a7000000-0000-4000-8000-000000000002}', '22222222-2222-4222-8222-222222222222')$$);
select test_helpers.check_err('a divisão cannot be opened on a personal subject', 'authenticated', pg_temp.u('alice'),
  $$insert into public.divide_plans (class_group_id, subject_id, title, node_ids, created_by) values ('77777777-7777-4777-8777-777777777777', 'a0000000-0000-4000-8000-000000000001', 'X', '{a7000000-0000-4000-8000-000000000002}', '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_err('clients cannot write assignments directly', 'authenticated', pg_temp.u('cris'),
  $$update public.divide_plans set assignments = '{}' where id = 'd2000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('a claimed topic cannot be claimed by someone else', 'authenticated', pg_temp.u('cris'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002')$$);
select test_helpers.check_ok('cris claims a free topic', 'authenticated', pg_temp.u('cris'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003')$$);
select test_helpers.check_ok('cris claims a second topic', 'authenticated', pg_temp.u('cris'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004')$$);
select test_helpers.check_err('max_claims caps the topics per member (SOC-06.1)', 'authenticated', pg_temp.u('cris'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005')$$);
select test_helpers.check_err('dave cannot claim in a Turma he is not in', 'authenticated', pg_temp.u('dave'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005')$$);
select test_helpers.check_ok('alice drafts her contribution on her topic', 'authenticated', pg_temp.u('alice'),
  $$insert into public.contributions (id, divide_plan_id, node_id, author_id, body_md) values ('f7000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Resumo')$$);
select test_helpers.check_err('alice cannot write on a topic she did not claim', 'authenticated', pg_temp.u('alice'),
  $$insert into public.contributions (divide_plan_id, node_id, author_id, body_md) values ('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'x')$$);
select test_helpers.check_err('alice cannot submit or review her own contribution', 'authenticated', pg_temp.u('alice'),
  $$update public.contributions set status = 'approved' where id = 'f7000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob cannot read alice''s draft', 'authenticated', pg_temp.u('bob'),
  $$select id from public.contributions$$, 0);
select test_helpers.check_rows('erin (moderator) can read it', 'authenticated', pg_temp.u('erin'),
  $$select id from public.contributions$$, 1);
select test_helpers.check_rows('divide_progress lists every claim with its state', 'authenticated', pg_temp.u('bob'),
  $$select * from public.divide_progress('d2000000-0000-4000-8000-000000000001')$$, 3);
select test_helpers.check_scalar('a draft shows as draft in the progress', 'authenticated', pg_temp.u('bob'),
  $$(select status from public.divide_progress('d2000000-0000-4000-8000-000000000001') where node_id = '40000000-0000-4000-8000-000000000002')$$, 'draft');
select test_helpers.check_ok('alice releases her topic while still a draft', 'authenticated', pg_temp.u('alice'),
  $$select public.claim_divide_topic('d2000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', false)$$);
select test_helpers.check_scalar('releasing deletes the draft', 'postgres', null,
  $$(select count(*) from public.contributions where id = 'f7000000-0000-4000-8000-000000000001')$$, '0');
select test_helpers.check_rows('cris cannot cancel erin''s divisão', 'authenticated', pg_temp.u('cris'),
  $$update public.divide_plans set status = 'cancelled' where id = 'd2000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('erin cannot mark her divisão done (server only)', 'authenticated', pg_temp.u('erin'),
  $$update public.divide_plans set status = 'done' where id = 'd2000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('erin cancels her divisão', 'authenticated', pg_temp.u('erin'),
  $$update public.divide_plans set status = 'cancelled' where id = 'd2000000-0000-4000-8000-000000000001'$$, 1);

-- =====================================================================
-- 6. Perguntas da turma (SOC-07)
-- =====================================================================
select test_helpers.check_rows('alice sees the pending peer question, not the rejected one', 'authenticated', pg_temp.u('alice'),
  $$select id from public.questions where origin = 'peer'$$, 1);
select test_helpers.check_err('bob cannot vote on his own question', 'authenticated', pg_temp.u('bob'),
  $$select public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_scalar('a first vote keeps it pending', 'authenticated', pg_temp.u('alice'),
  $$public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$, 'pending');
select test_helpers.check_scalar('voting twice counts once', 'authenticated', pg_temp.u('alice'),
  $$public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$, 'pending');
select test_helpers.check_scalar('a second member votes', 'authenticated', pg_temp.u('cris'),
  $$public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$, 'pending');
select test_helpers.check_err('dave (outsider) cannot vote', 'authenticated', pg_temp.u('dave'),
  $$select public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_scalar('the third 👍 approves it (SOC-07.3)', 'authenticated', pg_temp.u('erin'),
  $$public.vote_peer_question('b1000000-0000-4000-8000-000000000001')$$, 'approved');
select test_helpers.check_err('clients cannot insert votes directly', 'authenticated', pg_temp.u('alice'),
  $$insert into public.question_votes (question_id, user_id) values ('b1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_err('a member cannot review peer questions', 'authenticated', pg_temp.u('alice'),
  $$select public.review_peer_question('b1000000-0000-4000-8000-000000000002', true)$$);
select test_helpers.check_scalar('a moderator approves a peer question', 'authenticated', pg_temp.u('erin'),
  $$public.review_peer_question('b1000000-0000-4000-8000-000000000002', true)$$, 'approved');

-- =====================================================================
-- 7. Ligas semanais (SOC-08)
-- =====================================================================
select test_helpers.check_err('cris (not opted in) cannot see the league', 'authenticated', pg_temp.u('cris'),
  $$select * from public.league_board('77777777-7777-4777-8777-777777777777')$$);
select test_helpers.check_err('dave (outsider) cannot see the league', 'authenticated', pg_temp.u('dave'),
  $$select * from public.league_board('77777777-7777-4777-8777-777777777777')$$);
select test_helpers.check_rows('the board lists only opted-in members', 'authenticated', pg_temp.u('bob'),
  $$select * from public.league_board('77777777-7777-4777-8777-777777777777')$$, 2);
select test_helpers.check_scalar('daily league XP is capped at 500', 'authenticated', pg_temp.u('bob'),
  $$(select league_xp from public.league_board('77777777-7777-4777-8777-777777777777') where nickname = 'Ali')$$, '500');
select test_helpers.check_scalar('quiet-hours XP does not count for the league', 'authenticated', pg_temp.u('bob'),
  $$(select league_xp from public.league_board('77777777-7777-4777-8777-777777777777') where is_me)$$, '40');
select test_helpers.check_scalar('ranks follow league XP', 'authenticated', pg_temp.u('bob'),
  $$(select rank from public.league_board('77777777-7777-4777-8777-777777777777') where is_me)$$, '2');
select test_helpers.check_ok('a blocked pair is hidden from each other', 'postgres', null,
  $$insert into public.user_blocks (blocker_id, blocked_id) values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_rows('alice no longer sees bob on the board', 'authenticated', pg_temp.u('alice'),
  $$select * from public.league_board('77777777-7777-4777-8777-777777777777')$$, 1);
select test_helpers.check_err('clients cannot write league entries', 'authenticated', pg_temp.u('bob'),
  $$insert into public.league_entries (class_group_id, user_id, week_start, league_xp) values ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', date_trunc('week', now())::date, 9999)$$);
select test_helpers.check_sqlstate('a league week starts on a Monday',
  $$insert into public.league_entries (class_group_id, user_id, week_start) values ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', date_trunc('week', now())::date + 1)$$, '23514');

-- =====================================================================
-- 8. boss_attempts, retrospectives, performance_windows, nudge_events
-- =====================================================================
select test_helpers.check_rows('alice reads her boss attempt', 'authenticated', pg_temp.u('alice'),
  $$select id from public.boss_attempts$$, 1);
select test_helpers.check_rows('bob does not', 'authenticated', pg_temp.u('bob'),
  $$select id from public.boss_attempts$$, 0);
select test_helpers.check_err('clients cannot record boss attempts (quiz-submit does)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.boss_attempts (user_id, unit_node_id, quiz_attempt_id, passed, score) values ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', true, 1)$$);
select test_helpers.check_err('boss attempts are append-only', 'service_role', null,
  $$update public.boss_attempts set passed = false$$);
select test_helpers.check_rows('alice marks her Retrospectiva as seen', 'authenticated', pg_temp.u('alice'),
  $$update public.retrospectives set seen_at = now() where id = 'f4000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot rewrite its stats', 'authenticated', pg_temp.u('alice'),
  $$update public.retrospectives set stats = '{}' where id = 'f4000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob cannot see alice''s Retrospectiva', 'authenticated', pg_temp.u('bob'),
  $$select id from public.retrospectives$$, 0);
select test_helpers.check_sqlstate('a goal Retrospectiva needs its goal',
  $$insert into public.retrospectives (user_id, period_type, period_start, period_end, stats, title) values ('11111111-1111-4111-8111-111111111111', 'goal', '2026-01-01', '2026-02-01', '{}', 'X')$$, '23514');
select test_helpers.check_sqlstate('one Retrospectiva per period',
  $$insert into public.retrospectives (user_id, period_type, goal_id, period_start, period_end, stats, title) values ('11111111-1111-4111-8111-111111111111', 'goal', '60000000-0000-4000-8000-000000000001', '2026-10-01', '2026-12-01', '{}', 'X')$$, '23505');
select test_helpers.check_rows('alice reads her performance windows', 'authenticated', pg_temp.u('alice'),
  $$select bucket from public.performance_windows$$, 1);
select test_helpers.check_rows('bob does not', 'authenticated', pg_temp.u('bob'),
  $$select bucket from public.performance_windows$$, 0);
select test_helpers.check_sqlstate('buckets are 2-hour windows 0–11',
  $$insert into public.performance_windows (user_id, bucket) values ('22222222-2222-4222-8222-222222222222', 12)$$, '23514');
select test_helpers.check_ok('alice logs a burnout nudge', 'authenticated', pg_temp.u('alice'),
  $$insert into public.nudge_events (id, user_id, kind, surface) values ('f8000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'long_session', 'session')$$);
select test_helpers.check_rows('and records what she did', 'authenticated', pg_temp.u('alice'),
  $$update public.nudge_events set action = 'dismissed', action_at = now() where id = 'f8000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('a nudge cannot be logged for someone else', 'authenticated', pg_temp.u('alice'),
  $$insert into public.nudge_events (user_id, kind) values ('22222222-2222-4222-8222-222222222222', 'late_night')$$);
select test_helpers.check_rows('bob cannot read alice''s nudges', 'authenticated', pg_temp.u('bob'),
  $$select id from public.nudge_events$$, 0);
select test_helpers.check_sqlstate('an unknown nudge kind is rejected',
  $$insert into public.nudge_events (user_id, kind) values ('11111111-1111-4111-8111-111111111111', 'guilt_trip')$$, '23514');

-- ---------- GOL-09.2 calendar availability ----------
insert into public.availability_exceptions (user_id, local_date, minutes, source) values
  ('11111111-1111-4111-8111-111111111111', current_date + 3, 15, 'user');
select test_helpers.check_err('alice cannot write a calendar row directly', 'authenticated', pg_temp.u('alice'),
  $$insert into public.availability_exceptions (user_id, local_date, minutes, source) values ('11111111-1111-4111-8111-111111111111', current_date + 1, 30, 'calendar')$$);
select test_helpers.check_scalar('alice sends free minutes for three days', 'authenticated', pg_temp.u('alice'),
  $$public.set_calendar_availability(jsonb_build_array(
      jsonb_build_object('local_date', current_date + 1, 'minutes', 30),
      jsonb_build_object('local_date', current_date + 2, 'minutes', 0),
      jsonb_build_object('local_date', current_date + 3, 'minutes', 45)))$$, '3');
select test_helpers.check_scalar('the calendar row is stored with source calendar', 'authenticated', pg_temp.u('alice'),
  $$(select source || ':' || minutes from public.availability_exceptions where local_date = current_date + 1)$$, 'calendar:30');
select test_helpers.check_scalar('her own exception wins over the calendar', 'authenticated', pg_temp.u('alice'),
  $$(select source || ':' || minutes from public.availability_exceptions where local_date = current_date + 3)$$, 'user:15');
select test_helpers.check_scalar('a day without busy time clears the calendar row', 'authenticated', pg_temp.u('alice'),
  $$public.set_calendar_availability(jsonb_build_array(jsonb_build_object('local_date', current_date + 1, 'minutes', null)))$$, '1');
select test_helpers.check_rows('the cleared row is soft-deleted', 'authenticated', pg_temp.u('alice'),
  $$select 1 from public.availability_exceptions where local_date = current_date + 1 and deleted_at is null$$, 0);
select test_helpers.check_rows('bob cannot see alice''s calendar availability', 'authenticated', pg_temp.u('bob'),
  $$select 1 from public.availability_exceptions where user_id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_err('dates far in the future are rejected', 'authenticated', pg_temp.u('alice'),
  $$select public.set_calendar_availability(jsonb_build_array(jsonb_build_object('local_date', current_date + 90, 'minutes', 30)))$$);
select test_helpers.check_err('minutes above a day are rejected', 'authenticated', pg_temp.u('alice'),
  $$select public.set_calendar_availability(jsonb_build_array(jsonb_build_object('local_date', current_date + 1, 'minutes', 2000)))$$);
select test_helpers.check_err('anon cannot call it', 'anon', null,
  $$select public.set_calendar_availability('[]'::jsonb)$$);

select * from finish();
rollback;
