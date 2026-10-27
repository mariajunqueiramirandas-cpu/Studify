-- RLS, RPC and Realtime suite for the Phase 2 tables (data-model.md §5.1, §5.2, §5.3, §5.7, §5.9, §6.2, §8) and the
-- Phase 2 RPCs (api.md §5). Personas: alice (minor, Turma A member, owns a personal subject, guardian link), bob (Turma A
-- member), carol (Turma A moderator), dave (outside Turma A), erin (Turma A owner), guardian (auth user, no profile),
-- and twelve extra Turma A members who answer questions (class insights need at least five answerers).
-- Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

create or replace function pg_temp.u(p text) returns uuid
language sql immutable as $$
  select case p
    when 'alice'    then '11111111-1111-4111-8111-111111111111'
    when 'bob'      then '22222222-2222-4222-8222-222222222222'
    when 'carol'    then '33333333-3333-4333-8333-333333333333'
    when 'dave'     then '44444444-4444-4444-8444-444444444444'
    when 'erin'     then '55555555-5555-4555-8555-555555555555'
    when 'guardian' then '88888888-8888-4888-8888-888888888888'
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
  ('55555555-5555-4555-8555-555555555555', 'erin@studify.test'),
  ('88888888-8888-4888-8888-888888888888', 'guardian@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now()),
  ('33333333-3333-4333-8333-333333333333', 'Carol', 'approved', 2008, 8, 'v1', now()),
  ('44444444-4444-4444-8444-444444444444', 'Dave',  'approved', 2009, 2, 'v1', now()),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, 'v1', now());

insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',     'active', now()),
  ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'moderator', 'active', now()),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'member',    'active', now()),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'member',    'active', now());

-- Subjects: Biologia (alice's personal subject), Matematica (shared with Turma A, created by carol).
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf');
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'Matematica', '#aa0000', 'calc');

-- Twelve extra members of Turma A, each with a practice quiz and one attempt (ids are derived from i).
do $$
declare
  i int;
begin
  for i in 1..12 loop
    insert into auth.users (id, email) values
      (('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'colega' || i || '@studify.test');
    insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
      (('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'Colega ' || i, 'approved', 2009, 1, 'v1', now());
    insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
      ('77777777-7777-4777-8777-777777777777', ('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'member', 'active', now());
    insert into public.quizzes (id, owner_id, subject_id, kind, mode) values
      (('71000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       '50000000-0000-4000-8000-000000000001', 'practice', 'practice');
    insert into public.quiz_attempts (id, user_id, quiz_id, status, started_at, device_id) values
      (('72000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       ('71000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'submitted', now(), 'dev');
  end loop;
end $$;

-- Nodes: shared unit U, topics N1 and N2, concept C1 under N1; alice's unit and topic.
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Unidade 1'),
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Celulas');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao afim'),
  ('40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao quadratica'),
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'topic', 'Membrana');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'concept', 'Coeficiente angular');

insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d2000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333',
   'Apostila', 'notes', 'documents/50000000/d2000000.pdf', 1000, repeat('a', 64)),
  ('d2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'Calendario', 'other', 'photos/11111111/d2000000.jpg', 2000, repeat('b', 64));

-- Five questions on N1 (shared subject). Answers are seeded below.
insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, review_status) values
  ('c2000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Q1', '{}', 'generated', 'approved'),
  ('c2000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Q2', '{}', 'generated', 'approved'),
  ('c2000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Q3', '{}', 'generated', 'approved'),
  ('c2000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Q4', '{}', 'generated', 'approved'),
  ('c2000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Q5', '{}', 'generated', 'approved');

-- Answers of the twelve extra members (one attempt each). Q1: 12 answerers, 9 wrong (b x6, c x3).
-- Q2: 4 answerers. Q3: 6 answerers, 5 wrong. Q4: 6 answerers, 1 wrong. Q5: 5 answerers, all wrong.
do $$
declare
  q int;
  i int;
begin
  for q in 1..5 loop
    for i in 1..12 loop
      if (q = 1) or (q = 2 and i <= 4) or (q = 3 and i <= 6) or (q = 4 and i <= 6) or (q = 5 and i between 7 and 11) then
        insert into public.attempt_answers (id, attempt_id, user_id, question_id, question_version, response, correct, answered_at) values
          (('7a000000-0000-4000-8000-' || lpad((q * 100 + i)::text, 12, '0'))::uuid,
           ('72000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
           ('70000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
           ('c2000000-0000-4000-8000-' || lpad(q::text, 12, '0'))::uuid,
           1,
           jsonb_build_object('choice', case
             when q = 1 then (case when i <= 3 then 'a' when i <= 9 then 'b' else 'c' end)
             when q = 2 then 'a'
             when q = 3 then (case when i = 1 then 'a' else 'b' end)
             when q = 4 then (case when i = 1 then 'b' else 'a' end)
             else 'b' end),
           case when q = 1 then i <= 3 when q = 3 then i = 1 when q = 4 then i <> 1 else false end,
           now());
      end if;
    end loop;
  end loop;
end $$;

-- Quizzes: alice's practice quiz (for a share), the duel quiz, and two battle quizzes of carol.
insert into public.quizzes (id, owner_id, subject_id, kind, mode, question_ids) values
  ('81000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'practice', 'practice', '{}'),
  ('81000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000001', 'duel', 'practice', '{c2000000-0000-4000-8000-000000000001}'),
  ('81000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333', '50000000-0000-4000-8000-000000000001', 'battle', 'practice', '{c2000000-0000-4000-8000-000000000001}'),
  ('81000000-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', '50000000-0000-4000-8000-000000000001', 'battle', 'practice', '{c2000000-0000-4000-8000-000000000001}');

-- Duels: D1 waiting for bob, D2 finished (alice 120, bob 90).
insert into public.duels (id, class_group_id, challenger_id, opponent_id, quiz_id, status) values
  ('91000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '81000000-0000-4000-8000-000000000002', 'waiting_opponent');
insert into public.duels (id, class_group_id, challenger_id, opponent_id, quiz_id, status, challenger_score, opponent_score, winner_id) values
  ('91000000-0000-4000-8000-000000000002', '77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '81000000-0000-4000-8000-000000000002', 'finished', 120, 90, '11111111-1111-4111-8111-111111111111');

-- Battles: B1 in the lobby with alice and bob; B0 ended with the same PIN (the PIN is only unique among live battles).
insert into public.battles (id, class_group_id, host_id, quiz_id, pin, status) values
  ('92000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', '81000000-0000-4000-8000-000000000003', '4821', 'lobby');
insert into public.battles (id, class_group_id, host_id, quiz_id, pin, status, ended_at) values
  ('92000000-0000-4000-8000-000000000002', '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', '81000000-0000-4000-8000-000000000004', '4821', 'ended', now());
insert into public.battle_players (battle_id, user_id, nickname) values
  ('92000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Ali'),
  ('92000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bob');

-- Guardian (alice is 15): a pending link and the limits the guardian set.
insert into public.guardian_links (id, student_id, guardian_email, status, verify_token_hash) values
  ('93000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'pai@studify.test', 'pending', 'hash-1');
insert into public.guardian_settings (student_id, daily_limit_min) values
  ('11111111-1111-4111-8111-111111111111', 60);

-- ING-07 import draft for alice: two exams (Biologia matches her personal subject; Matematica the shared one).
insert into public.schedule_imports (id, user_id, document_id, extracted, status) values
  ('95000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'd2000000-0000-4000-8000-000000000002',
   jsonb_build_array(
     jsonb_build_object('subject_name', 'Biologia', 'title', 'Prova de citologia', 'local_date', ((now() at time zone 'America/Sao_Paulo')::date + 10)::text),
     jsonb_build_object('subject_name', 'Matematica', 'title', 'P2', 'local_date', ((now() at time zone 'America/Sao_Paulo')::date + 12)::text)),
   'draft');

-- Feed: F1 personal to alice (her subject), F2 shared with the Turma, F3 personal to bob (shared subject).
insert into public.feed_items (id, subject_id, node_id, concept_id, type, content, personal_for_user_id) values
  ('96000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', null, 'did_you_know', '{"text":"x"}', '11111111-1111-4111-8111-111111111111');
insert into public.feed_items (id, subject_id, node_id, concept_id, type, content) values
  ('96000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', 'micro_lesson', '{"text":"y"}');
insert into public.feed_items (id, subject_id, node_id, concept_id, type, content, personal_for_user_id) values
  ('96000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', 'quick_question', '{"text":"z"}', '22222222-2222-4222-8222-222222222222');

insert into public.feed_impressions (id, user_id, feed_item_id, item_kind, item_ref_id, shown_at, dwell_ms, action) values
  ('97000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '96000000-0000-4000-8000-000000000002', 'feed_item', '96000000-0000-4000-8000-000000000002', now(), 1200, 'read');

-- Motivation: one XP event, today's activity and a streak for alice; four achievements, none shown yet.
insert into public.xp_events (id, user_id, amount, source_feature, ref_type, ref_id, occurred_at, local_date) values
  ('98000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 5, 'SOC-02', 'duel', '91000000-0000-4000-8000-000000000002', now(), (now() at time zone 'America/Sao_Paulo')::date);
insert into public.daily_activity (user_id, local_date, active_minutes, xp) values
  ('11111111-1111-4111-8111-111111111111', (now() at time zone 'America/Sao_Paulo')::date, 30, 5);
insert into public.streaks (user_id, current_length, longest_length) values
  ('11111111-1111-4111-8111-111111111111', 3, 3);
insert into public.achievements (user_id, code, unlocked_at) values
  ('11111111-1111-4111-8111-111111111111', 'first_review', now()),
  ('11111111-1111-4111-8111-111111111111', 'streak_7', now()),
  ('11111111-1111-4111-8111-111111111111', 'duel_10', now()),
  ('11111111-1111-4111-8111-111111111111', 'turma_10', now());

-- AI usage today (user day budgets): alice spent 25% (TUT-01 20, PRA-01 5), bob spent 90% (TUT-01 90).
insert into private.ai_budgets (scope_type, scope_id, period_type, period_start, limit_micro_usd, spent_micro_usd) values
  ('user', '11111111-1111-4111-8111-111111111111', 'day', (now() at time zone 'America/Sao_Paulo')::date, 1000000, 250000),
  ('user', '22222222-2222-4222-8222-222222222222', 'day', (now() at time zone 'America/Sao_Paulo')::date, 1000000, 900000);
insert into public.ai_usage (user_id, feature, task, model, cost_micro_usd, price_version) values
  ('11111111-1111-4111-8111-111111111111', 'TUT-01', 'tutor.answer', 'claude-test', 200000, 'p1'),
  ('11111111-1111-4111-8111-111111111111', 'PRA-01', 'quiz.generate', 'claude-test', 50000, 'p1'),
  ('22222222-2222-4222-8222-222222222222', 'TUT-01', 'tutor.answer', 'claude-test', 900000, 'p1');

-- =====================================================================
-- 0. Every Phase 2 table has row level security on, and the publication lists the duel table
-- =====================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind = 'r'
      and c.relname = any(array['duels','battles','battle_players','quiz_shares','guardian_links','guardian_settings',
        'schedule_imports','feed_items','feed_impressions','xp_events','daily_activity','streaks','achievements',
        'question_served','class_insights'])
      and c.relrowsecurity),
  15, 'all 15 Phase 2 tables have row level security enabled');

select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'duels'),
  1, 'the duels table is in the supabase_realtime publication');

select test_helpers.check_err('clients cannot read the private insight aggregates', 'authenticated', pg_temp.u('alice'),
  $$select 1 from private.class_insights$$);
select test_helpers.check_err('clients cannot read the private question_served table', 'authenticated', pg_temp.u('alice'),
  $$select 1 from private.question_served$$);

-- =====================================================================
-- 1. Duels (SOC-02): only the two players read a duel; blocks and outsiders cannot challenge
-- =====================================================================
select test_helpers.check_rows('alice (challenger) reads duel D1', 'authenticated', pg_temp.u('alice'),
  $$select id from public.duels where id = '91000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob (opponent) reads duel D1', 'authenticated', pg_temp.u('bob'),
  $$select id from public.duels where id = '91000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('carol (moderator, not a player) reads no duel', 'authenticated', pg_temp.u('carol'),
  $$select id from public.duels$$, 0);
select test_helpers.check_rows('dave (outsider) reads no duel', 'authenticated', pg_temp.u('dave'),
  $$select id from public.duels$$, 0);
select test_helpers.check_err('a client cannot create a duel (Edge Functions only)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.duels (class_group_id, challenger_id, opponent_id, quiz_id) values
    ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '81000000-0000-4000-8000-000000000002')$$);
select test_helpers.check_sqlstate('a duel needs two members of the Turma (dave is outside)',
  $$insert into public.duels (class_group_id, challenger_id, opponent_id, quiz_id) values
    ('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '81000000-0000-4000-8000-000000000002')$$,
  'P0001');
select test_helpers.check_rows('alice sees both players of the finished duel D2 in the public view', 'authenticated', pg_temp.u('alice'),
  $$select user_id from public.duel_participants_public where duel_id = '91000000-0000-4000-8000-000000000002'$$, 2);
select test_helpers.check_rows('dave sees no duel participants', 'authenticated', pg_temp.u('dave'),
  $$select user_id from public.duel_participants_public$$, 0);

-- Carol blocks alice: no duel between them (SOC-02.11), enforced by the database.
insert into public.user_blocks (blocker_id, blocked_id) values
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
select test_helpers.check_sqlstate('blocked users cannot duel each other (either direction)',
  $$insert into public.duels (class_group_id, challenger_id, opponent_id, quiz_id) values
    ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '81000000-0000-4000-8000-000000000002')$$,
  'P0001');

-- block_user cancels the open duel between bob and alice, not the finished one (SOC-02.10: no penalty).
select test_helpers.check_ok('bob blocks alice', 'authenticated', pg_temp.u('bob'),
  $$select public.block_user('11111111-1111-4111-8111-111111111111')$$);
select is((select status from public.duels where id = '91000000-0000-4000-8000-000000000001'), 'cancelled',
  'blocking cancels the open duel between the pair');
select is((select status from public.duels where id = '91000000-0000-4000-8000-000000000002'), 'finished',
  'blocking leaves finished duels alone');
select test_helpers.check_err('block_user refuses to block oneself', 'authenticated', pg_temp.u('bob'),
  $$select public.block_user('22222222-2222-4222-8222-222222222222')$$);

-- =====================================================================
-- 2. Battles (SOC-03): Turma members see the lobby and its players; outsiders see nothing
-- =====================================================================
select test_helpers.check_rows('bob (Turma member) sees the battles of Turma A', 'authenticated', pg_temp.u('bob'),
  $$select id from public.battles$$, 2);
select test_helpers.check_rows('dave (outsider) sees no battle', 'authenticated', pg_temp.u('dave'),
  $$select id from public.battles$$, 0);
select test_helpers.check_rows('bob (member) sees the two players of battle B1', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.battle_players where battle_id = '92000000-0000-4000-8000-000000000001'$$, 2);
select test_helpers.check_rows('carol (host) sees the players of battle B1', 'authenticated', pg_temp.u('carol'),
  $$select user_id from public.battle_players where battle_id = '92000000-0000-4000-8000-000000000001'$$, 2);
select test_helpers.check_rows('dave (outsider) sees no battle players', 'authenticated', pg_temp.u('dave'),
  $$select user_id from public.battle_players$$, 0);
select test_helpers.check_err('a client cannot join a battle (battle-join Edge Function only)', 'authenticated', pg_temp.u('dave'),
  $$insert into public.battle_players (battle_id, user_id, nickname) values ('92000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'Dave')$$);
select test_helpers.check_sqlstate('a non-member cannot join a battle',
  $$insert into public.battle_players (battle_id, user_id, nickname) values ('92000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'Dave')$$,
  'P0001');
select test_helpers.check_sqlstate('two live battles cannot share a PIN',
  $$insert into public.battles (class_group_id, host_id, quiz_id, pin, status) values
    ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', '81000000-0000-4000-8000-000000000004', '4821', 'lobby')$$,
  '23505');

-- =====================================================================
-- 3. Quiz shares (SOC-09): the creator only
-- =====================================================================
select test_helpers.check_ok('alice shares her practice quiz', 'authenticated', pg_temp.u('alice'),
  $$insert into public.quiz_shares (quiz_id, created_by, token, snapshot) values
    ('81000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'ABCDEFGHJKMNPQRSTUVWXY', '{"questions":[]}')$$);
select test_helpers.check_rows('alice reads her own share', 'authenticated', pg_temp.u('alice'),
  $$select id from public.quiz_shares$$, 1);
select test_helpers.check_rows('bob (same Turma) does not read alice share', 'authenticated', pg_temp.u('bob'),
  $$select id from public.quiz_shares$$, 0);
select test_helpers.check_err('bob cannot share alice quiz as himself', 'authenticated', pg_temp.u('bob'),
  $$insert into public.quiz_shares (quiz_id, created_by, token) values
    ('81000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'BCDEFGHJKMNPQRSTUVWXYZ')$$);
select test_helpers.check_err('alice cannot change the use count of her share', 'authenticated', pg_temp.u('alice'),
  $$update public.quiz_shares set uses = 99$$);
select test_helpers.check_rows('alice revokes her share', 'authenticated', pg_temp.u('alice'),
  $$update public.quiz_shares set revoked_at = now()$$, 1);
select test_helpers.check_sqlstate('share tokens have the 22-character form',
  $$insert into public.quiz_shares (quiz_id, created_by, token) values
    ('81000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'curto')$$,
  '23514');

-- =====================================================================
-- 4. Guardian supervision (SP-03, SP-04): only the student reads their link and limits
-- =====================================================================
select test_helpers.check_rows('alice (student) reads her guardian link', 'authenticated', pg_temp.u('alice'),
  $$select id from public.guardian_links$$, 1);
select test_helpers.check_rows('bob cannot read alice guardian link', 'authenticated', pg_temp.u('bob'),
  $$select id from public.guardian_links$$, 0);
select test_helpers.check_rows('the guardian (no profile) cannot read the link', 'authenticated', pg_temp.u('guardian'),
  $$select id from public.guardian_links$$, 0);
select test_helpers.check_rows('alice reads the limits set for her', 'authenticated', pg_temp.u('alice'),
  $$select student_id from public.guardian_settings$$, 1);
select test_helpers.check_rows('bob reads no guardian settings', 'authenticated', pg_temp.u('bob'),
  $$select student_id from public.guardian_settings$$, 0);
select test_helpers.check_err('a student cannot lift the limit set by the guardian', 'authenticated', pg_temp.u('alice'),
  $$update public.guardian_settings set daily_limit_min = null$$);
select test_helpers.check_err('a student cannot add a guardian link', 'authenticated', pg_temp.u('alice'),
  $$insert into public.guardian_links (student_id, guardian_email, verify_token_hash) values
    ('11111111-1111-4111-8111-111111111111', 'outro@studify.test', 'h')$$);

-- =====================================================================
-- 5. ING-07 schedule import: the owner applies it and gets draft exams; others cannot
-- =====================================================================
select test_helpers.check_rows('alice reads her schedule import', 'authenticated', pg_temp.u('alice'),
  $$select id from public.schedule_imports$$, 1);
select test_helpers.check_rows('bob reads no schedule import', 'authenticated', pg_temp.u('bob'),
  $$select id from public.schedule_imports$$, 0);
select test_helpers.check_err('bob cannot apply alice import', 'authenticated', pg_temp.u('bob'),
  $$select public.apply_schedule_import('95000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_ok('alice applies her import', 'authenticated', pg_temp.u('alice'),
  $$select public.apply_schedule_import('95000000-0000-4000-8000-000000000001')$$);
select is((select count(*)::int from public.exams where user_id = '11111111-1111-4111-8111-111111111111' and status = 'draft'),
  2, 'applying the import creates one draft exam per item');
select is((select subject_id from public.exams where user_id = '11111111-1111-4111-8111-111111111111' and title = 'Prova de citologia'),
  'a0000000-0000-4000-8000-000000000001'::uuid, 'the Biologia item is matched to her subject by name');
select is((select count(*)::int from public.goals where user_id = '11111111-1111-4111-8111-111111111111' and mode = 'exam_week'),
  1, 'applying creates one exam_week goal for the import');
select is((select status from public.schedule_imports where id = '95000000-0000-4000-8000-000000000001'), 'applied',
  'the import is marked applied');
select test_helpers.check_err('an applied import cannot be applied again', 'authenticated', pg_temp.u('alice'),
  $$select public.apply_schedule_import('95000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_err('a client cannot create a schedule import', 'authenticated', pg_temp.u('alice'),
  $$insert into public.schedule_imports (user_id, document_id) values ('11111111-1111-4111-8111-111111111111', 'd2000000-0000-4000-8000-000000000002')$$);

-- =====================================================================
-- 6. Feed (FED-01): items follow the R8 rule; impressions and XP are append-only for everyone
-- =====================================================================
select test_helpers.check_rows('alice reads her personal item and the shared item', 'authenticated', pg_temp.u('alice'),
  $$select id from public.feed_items$$, 2);
select test_helpers.check_rows('bob reads the shared item and his own, not alice item', 'authenticated', pg_temp.u('bob'),
  $$select id from public.feed_items$$, 2);
select test_helpers.check_rows('dave reads no feed item', 'authenticated', pg_temp.u('dave'),
  $$select id from public.feed_items$$, 0);
select test_helpers.check_err('a client cannot create a feed item', 'authenticated', pg_temp.u('alice'),
  $$insert into public.feed_items (subject_id, node_id, type, content) values
    ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'did_you_know', '{}')$$);
select test_helpers.check_sqlstate('a micro lesson needs a concept',
  $$insert into public.feed_items (subject_id, node_id, type, content) values
    ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'micro_lesson', '{}')$$,
  '23514');
select test_helpers.check_rows('alice reads her impression', 'authenticated', pg_temp.u('alice'),
  $$select id from public.feed_impressions$$, 1);
select test_helpers.check_rows('bob reads no impression of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.feed_impressions$$, 0);
select test_helpers.check_err('alice cannot change an impression', 'authenticated', pg_temp.u('alice'),
  $$update public.feed_impressions set dwell_ms = 0$$);
select test_helpers.check_err('alice cannot delete an impression', 'authenticated', pg_temp.u('alice'),
  $$delete from public.feed_impressions$$);
select test_helpers.check_err('the service role cannot change an impression (append-only trigger)', 'service_role', null,
  $$update public.feed_impressions set dwell_ms = 0$$);
select test_helpers.check_err('the service role cannot delete an impression (append-only trigger)', 'service_role', null,
  $$delete from public.feed_impressions$$);
select test_helpers.check_rows('alice reads her XP events', 'authenticated', pg_temp.u('alice'),
  $$select id from public.xp_events$$, 1);
select test_helpers.check_rows('bob reads no XP events of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.xp_events$$, 0);
select test_helpers.check_err('alice cannot change an XP event', 'authenticated', pg_temp.u('alice'),
  $$update public.xp_events set amount = 999$$);
select test_helpers.check_err('the service role cannot change an XP event (append-only trigger)', 'service_role', null,
  $$update public.xp_events set amount = 999$$);
select test_helpers.check_sqlstate('the same award cannot be recorded twice',
  $$insert into public.xp_events (id, user_id, amount, source_feature, ref_type, ref_id, occurred_at, local_date) values
    ('98000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 5, 'SOC-02', 'duel', '91000000-0000-4000-8000-000000000002', now(), current_date)$$,
  '23505');

-- =====================================================================
-- 7. Motivation (MOT-01): own activity and streak; achievements shown in the Turma (at most 3)
-- =====================================================================
select test_helpers.check_rows('alice reads her daily activity', 'authenticated', pg_temp.u('alice'),
  $$select user_id from public.daily_activity$$, 1);
select test_helpers.check_rows('bob reads no daily activity of alice', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.daily_activity$$, 0);
select test_helpers.check_err('alice cannot write her streak', 'authenticated', pg_temp.u('alice'),
  $$update public.streaks set current_length = 99$$);
select test_helpers.check_scalar('the reset notice starts unshown', 'authenticated', pg_temp.u('alice'),
  $$select reset_notice_pending::text from public.streaks where user_id = '11111111-1111-4111-8111-111111111111'$$, 'false');
select test_helpers.check_rows('bob sees no achievement before alice shows one', 'authenticated', pg_temp.u('bob'),
  $$select code from public.achievements$$, 0);
select test_helpers.check_rows('alice shows first_review on her Turma card', 'authenticated', pg_temp.u('alice'),
  $$update public.achievements set show_in_turma = true where code = 'first_review'$$, 1);
select test_helpers.check_ok('alice shows streak_7 (second)', 'authenticated', pg_temp.u('alice'),
  $$update public.achievements set show_in_turma = true where code = 'streak_7'$$);
select test_helpers.check_ok('alice shows duel_10 (third)', 'authenticated', pg_temp.u('alice'),
  $$update public.achievements set show_in_turma = true where code = 'duel_10'$$);
select test_helpers.check_err('a fourth achievement cannot be shown in the Turma', 'authenticated', pg_temp.u('alice'),
  $$update public.achievements set show_in_turma = true where code = 'turma_10'$$);
select test_helpers.check_rows('bob (classmate) sees the three achievements shown', 'authenticated', pg_temp.u('bob'),
  $$select code from public.achievements$$, 3);
select test_helpers.check_rows('dave (outsider) sees no achievement', 'authenticated', pg_temp.u('dave'),
  $$select code from public.achievements$$, 0);
select test_helpers.check_err('alice cannot change the unlock date of an achievement', 'authenticated', pg_temp.u('alice'),
  $$update public.achievements set unlocked_at = null$$);

-- =====================================================================
-- 8. Class insights (SOC-04, spec 10 §8.4, learning-engine §18.3): aggregates only, k >= 5, opt-out respected
-- =====================================================================
select test_helpers.check_err('dave (outsider) cannot read the insights', 'authenticated', pg_temp.u('dave'),
  $$select public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_scalar('Q1 (12 answerers) shows the wrong rate rounded to 5 percent', 'authenticated', pg_temp.u('bob'),
  $$select r->>'pct_wrong' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000001'$$,
  '75');
select test_helpers.check_scalar('Q1 shows the 10+ size bucket', 'authenticated', pg_temp.u('bob'),
  $$select r->>'n_bucket' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000001'$$,
  '10+');
select test_helpers.check_scalar('Q1 shows the wrong option chosen by 3 or more (b at 50 percent)', 'authenticated', pg_temp.u('bob'),
  $$select r->'option_pcts'->>'b' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000001'$$,
  '50');
select test_helpers.check_scalar('Q1 does not show the correct option', 'authenticated', pg_temp.u('bob'),
  $$select (r->'option_pcts' ? 'a')::text from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000001'$$,
  'false');
select test_helpers.check_scalar('Q2 (4 answerers, below k = 5) is not shown', 'authenticated', pg_temp.u('bob'),
  $$select count(*)::text from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000002'$$,
  '0');
select test_helpers.check_scalar('Q3 (6 answerers, 5 wrong) is a band only: dificil, no percentage', 'authenticated', pg_temp.u('bob'),
  $$select (r->>'band') || '/' || coalesce(r->>'pct_wrong', 'null') from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000003'$$,
  'dificil/null');
select test_helpers.check_scalar('Q4 (6 answerers, 1 wrong) is a band only: tranquila', 'authenticated', pg_temp.u('bob'),
  $$select r->>'band' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000004'$$,
  'tranquila');
select test_helpers.check_scalar('the topic aggregate is the mean of its qualifying questions (70 percent)', 'authenticated', pg_temp.u('bob'),
  $$select r->>'pct_wrong' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' is null and r->>'node_id' = '40000000-0000-4000-8000-000000000002'$$,
  '70');
select test_helpers.check_scalar('the subject view has the 4 question rows and the topic row', 'authenticated', pg_temp.u('alice'),
  $$select count(*)::text from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001'))$$,
  '5');
select test_helpers.check_scalar('a node without questions has no insight', 'authenticated', pg_temp.u('alice'),
  $$public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004')::text$$,
  '[]');
select test_helpers.check_scalar('the insight rows have a fixed shape', 'authenticated', pg_temp.u('alice'),
  $$select string_agg(distinct k, ',' order by k) from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r, jsonb_object_keys(r) k$$,
  'band,n_bucket,node_id,option_pcts,pct_wrong,question_id');
select test_helpers.check_scalar('the insights never contain a member id', 'authenticated', pg_temp.u('alice'),
  $$select (select count(*) from generate_series(1, 12) g
             where position(('70000000-0000-4000-8000-' || lpad(g::text, 12, '0')) in
                           public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')::text) > 0)
         + (select count(*) from unnest(array['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
                                              '33333333-3333-4333-8333-333333333333']) u
             where position(u in public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')::text) > 0)$$,
  '0');
select test_helpers.check_rows('a member opts out of the statistics (SOC-04.6)', 'authenticated', '70000000-0000-4000-8000-000000000007'::uuid,
  $$update public.class_group_members set contribute_insights = false
     where class_group_id = '77777777-7777-4777-8777-777777777777' and user_id = '70000000-0000-4000-8000-000000000007'$$, 1);
select test_helpers.check_scalar('after the opt-out Q5 (now 4 answerers) disappears', 'authenticated', pg_temp.u('bob'),
  $$select count(*)::text from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' = 'c2000000-0000-4000-8000-000000000005'$$,
  '0');
select test_helpers.check_scalar('after the opt-out the topic mean drops to 60 percent over three questions', 'authenticated', pg_temp.u('bob'),
  $$select r->>'pct_wrong' from jsonb_array_elements(public.class_insights_for('77777777-7777-4777-8777-777777777777', '50000000-0000-4000-8000-000000000001')) r where r->>'question_id' is null and r->>'node_id' = '40000000-0000-4000-8000-000000000002'$$,
  '60');

-- =====================================================================
-- 9. AI usage today (PLT-04): the caller's percentage only; never money, never another user's rows
-- =====================================================================
select test_helpers.check_scalar('alice has used 25 percent of today limit', 'authenticated', pg_temp.u('alice'),
  $$public.my_ai_usage_today()->>'pct'$$, '25');
select test_helpers.check_scalar('alice TUT-01 share is 20 percent (bob spending does not show)', 'authenticated', pg_temp.u('alice'),
  $$select x->>'pct' from jsonb_array_elements(public.my_ai_usage_today()->'byFeature') x where x->>'feature' = 'TUT-01'$$, '20');
select test_helpers.check_scalar('bob has used 90 percent of his limit (his own rows only)', 'authenticated', pg_temp.u('bob'),
  $$public.my_ai_usage_today()->>'pct'$$, '90');
select test_helpers.check_scalar('carol with no usage has 0 percent and no features', 'authenticated', pg_temp.u('carol'),
  $$public.my_ai_usage_today()->>'pct'$$, '0');
select test_helpers.check_scalar('carol byFeature is empty', 'authenticated', pg_temp.u('carol'),
  $$jsonb_array_length(public.my_ai_usage_today()->'byFeature')::text$$, '0');
select test_helpers.check_scalar('the answer has only the keys pct and byFeature', 'authenticated', pg_temp.u('alice'),
  $$select string_agg(k, ',' order by k) from jsonb_object_keys(public.my_ai_usage_today()) k$$, 'byFeature,pct');
select test_helpers.check_scalar('the answer contains no money amount', 'authenticated', pg_temp.u('alice'),
  $$position('usd' in lower(public.my_ai_usage_today()::text)) + position('micro' in lower(public.my_ai_usage_today()::text))$$, '0');
select test_helpers.check_err('anonymous callers cannot read AI usage', 'anon', null,
  $$select public.my_ai_usage_today()$$);

-- =====================================================================
-- 10. Realtime authorization (data-model §8.2): private channels are read by their members only
-- =====================================================================
select test_helpers.check_scalar('two policies guard realtime.messages', 'authenticated', pg_temp.u('alice'),
  $$select count(*)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages'$$, '2');

insert into realtime.messages (topic, extension, event, payload) values
  ('battle:92000000-0000-4000-8000-000000000001', 'broadcast', 'state', '{}');

select set_config('realtime.topic', 'duel:91000000-0000-4000-8000-000000000001', true);
select test_helpers.check_rows('alice (challenger) joins the duel channel', 'authenticated', pg_temp.u('alice'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('bob (opponent) joins the duel channel', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('carol cannot join the duel channel of others', 'authenticated', pg_temp.u('carol'),
  $$select id from realtime.messages$$, 0);

select set_config('realtime.topic', 'battle:92000000-0000-4000-8000-000000000001', true);
select test_helpers.check_rows('a battle player joins the battle channel', 'authenticated', pg_temp.u('alice'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('the host joins the battle channel', 'authenticated', pg_temp.u('carol'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('an outsider cannot join the battle channel', 'authenticated', pg_temp.u('dave'),
  $$select id from realtime.messages$$, 0);

select set_config('realtime.topic', 'turma:77777777-7777-4777-8777-777777777777', true);
select test_helpers.check_rows('an active Turma member joins the Turma channel', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('an outsider cannot join the Turma channel', 'authenticated', pg_temp.u('dave'),
  $$select id from realtime.messages$$, 0);
select set_config('realtime.topic', 'turma:77777777-7777-4777-8777-777777777777:mods', true);
select test_helpers.check_rows('a moderator joins the moderators channel', 'authenticated', pg_temp.u('carol'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('a plain member does not join the moderators channel', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 0);

select set_config('realtime.topic', 'user:11111111-1111-4111-8111-111111111111', true);
select test_helpers.check_rows('a user joins their own channel', 'authenticated', pg_temp.u('alice'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('another user cannot join that channel', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 0);

select set_config('realtime.topic', 'battle:92000000-0000-4000-8000-000000000001', true);
select test_helpers.check_ok('alice (player) sends presence in the battle', 'authenticated', pg_temp.u('alice'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('battle:92000000-0000-4000-8000-000000000001', 'presence', 'presence_diff', '{}')$$);
select test_helpers.check_err('dave cannot send presence in the battle', 'authenticated', pg_temp.u('dave'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('battle:92000000-0000-4000-8000-000000000001', 'presence', 'presence_diff', '{}')$$);
select test_helpers.check_err('clients cannot broadcast (only presence)', 'authenticated', pg_temp.u('alice'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('battle:92000000-0000-4000-8000-000000000001', 'broadcast', 'state', '{}')$$);

select * from finish();
rollback;
