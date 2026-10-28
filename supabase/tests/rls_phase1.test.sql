-- RLS and RPC suite for the Phase 1 tables (data-model.md §5.3-§5.7, §6.2) and the Phase 1 RPCs
-- (api.md §5). Personas: alice (minor, Turma A member, owns a personal subject and a goal), bob (Turma A member),
-- carol (Turma A moderator), dave (outside Turma A), erin (Turma A owner, app admin), frank (joins with the code).
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
    when 'frank' then '66666666-6666-4666-8666-666666666666'
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
  ('66666666-6666-4666-8666-666666666666', 'frank@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, app_role) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now(), 'user'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now(), 'user'),
  ('33333333-3333-4333-8333-333333333333', 'Carol', 'approved', 2008, 8, 'v1', now(), 'user'),
  ('44444444-4444-4444-8444-444444444444', 'Dave',  'approved', 2009, 2, 'v1', now(), 'user'),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, 'v1', now(), 'app_admin'),
  ('66666666-6666-4666-8666-666666666666', 'Frank', 'approved', 2008, 1, 'v1', now(), 'user');

insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',     'active', now()),
  ('77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'moderator', 'active', now()),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'member',    'active', now()),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'member',    'active', now());
insert into public.invites (code, created_by, class_group_id) values
  ('ABCD2345', '55555555-5555-4555-8555-555555555555', '77777777-7777-4777-8777-777777777777');

-- Personal subject of alice; shared subject of Turma A (created by carol).
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf');
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'Matematica', '#aa0000', 'calc');

insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('d1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333',
   'Apostila', 'notes', 'documents/50000000/d1000000.pdf', 1000, repeat('a', 64));

-- Turma map: U1 (unit) > T1 (topic) > C1 (concept); U1 > T2 (topic). Alice's map: B1 (unit) > B1t (topic).
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Unidade 1'),
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Celulas');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao afim'),
  ('40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao quadratica'),
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'topic', 'Membrana');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'concept', 'Coeficiente angular');

insert into public.node_sources (node_id, document_id, page_start, page_end, origin) values
  ('40000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 1, 4, 'ai'),
  ('40000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000001', 5, 8, 'ai');

insert into public.notes (id, subject_id, node_id, depth, body, language, status, created_by) values
  ('41000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'study', 'Resumo da funcao', 'pt-BR', 'ready', '33333333-3333-4333-8333-333333333333'),
  ('41000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'tldr', 'Resumo das celulas', 'pt-BR', 'ready', '11111111-1111-4111-8111-111111111111');

insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by) values
  ('c0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'Q shared', 'A shared', 'generated', '33333333-3333-4333-8333-333333333333'),
  ('c0000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'Q split', 'A split', 'generated', '33333333-3333-4333-8333-333333333333');
insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by, personal_for_user_id) values
  ('c0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'basic', 'Q bob', 'A bob', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
insert into public.cards (id, subject_id, node_id, type, front, back, origin, created_by) values
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'basic', 'Q alice', 'A alice', 'user', '11111111-1111-4111-8111-111111111111');
update public.cards set source_pages = '[{"document_id":"d1000000-0000-4000-8000-000000000001","page_start":4,"page_end":4}]'
 where id = 'c0000000-0000-4000-8000-000000000004';

insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, review_status) values
  ('b1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Quanto e 1+1?', '{}', 'generated', 'approved'),
  ('b1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'mcq_single', 'Qual organela?', '{}', 'generated', 'approved');
insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, author_id, personal_for_user_id, review_status) values
  ('b1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'mcq_single', 'Pergunta do Bob', '{}', 'user', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'approved');

insert into public.glossary_terms (id, subject_id, node_id, term, definition) values
  ('42000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'Função afim', 'a·x + b');

insert into public.explanations (id, subject_id, target_type, target_id, paragraph_index, style, language, body, prompt_version) values
  ('43000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'note_paragraph', '41000000-0000-4000-8000-000000000001', 0, 'simpler', 'pt-BR', 'Explicacao simples', 'v1');
insert into public.explanations (id, subject_id, target_type, target_id, style, language, body, personal_for_user_id, prompt_version) values
  ('43000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', 'concept', '40000000-0000-4000-8000-000000000003', 'analogy', 'pt-BR', 'Analogia do Bob', '22222222-2222-4222-8222-222222222222', 'v1');

-- Flags on a shared question (bob, carol) and on a shared note (carol).
insert into public.content_flags (id, item_type, item_id, item_version, class_group_id, reporter_id, reason) values
  ('b5000000-0000-4000-8000-000000000001', 'question', 'b1000000-0000-4000-8000-000000000001', 1, '77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'wrong_answer'),
  ('b5000000-0000-4000-8000-000000000002', 'question', 'b1000000-0000-4000-8000-000000000001', 1, '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'unclear'),
  ('b5000000-0000-4000-8000-000000000003', 'note', '41000000-0000-4000-8000-000000000001', 1, '77777777-7777-4777-8777-777777777777', '33333333-3333-4333-8333-333333333333', 'other');

insert into public.user_reports (id, reporter_id, reported_id, class_group_id, reason, context_type, context_id) values
  ('f2000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777', 'inappropriate_content', 'card', 'c0000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', null, '77777777-7777-4777-8777-777777777777', 'spam', null, null),
  ('f2000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', null, '77777777-7777-4777-8777-777777777777', 'other', 'card', 'c0000000-0000-4000-8000-000000000003');

-- Goals and exams of alice: e_alice in 3 days, e_alice2 in 5 days, e_far in 30 days.
insert into public.goals (id, user_id, mode, name, start_date, end_date) values
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'exam_week', 'Semana', '2026-01-01', '2026-12-31');
insert into public.exams (id, goal_id, user_id, subject_id, title, local_date) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'Prova de biologia', (now() at time zone 'America/Sao_Paulo')::date + 3),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'Prova de bio 2', (now() at time zone 'America/Sao_Paulo')::date + 5),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'Prova distante', (now() at time zone 'America/Sao_Paulo')::date + 30);

-- Grading: P1 (exam e_alice), P2 (exam e_alice2), T (no exam, graded 8). Weights 0.4 / 0.4 / 0.2.
insert into public.grading_rules (id, owner_profile_id, school_year, formula) values
  ('b0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 2,
   '{"scale_max":10,"grade_step":0.1,"passing_average":6,"term_formula":"weighted_average"}');
insert into public.grade_components (id, user_id, subject_id, school_year, term_index, name, kind, weight, grade, exam_id, position) values
  ('b2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 2, 1, 'P1', 'exam', 0.4, null, 'a2000000-0000-4000-8000-000000000001', 1),
  ('b2000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 2, 1, 'P2', 'exam', 0.4, null, 'a2000000-0000-4000-8000-000000000002', 2),
  ('b2000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 2, 1, 'Trabalho', 'assignment', 0.2, 8, null, 3);

-- Quizzes, attempts and answers of alice and bob, a mistake and mastery evidence for alice.
insert into public.quizzes (id, owner_id, subject_id, kind, mode, question_ids) values
  ('a8000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'practice', 'practice', '{b1000000-0000-4000-8000-000000000003}');
insert into public.quizzes (id, owner_id, subject_id, kind, mode, question_ids) values
  ('a8000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', '50000000-0000-4000-8000-000000000001', 'practice', 'practice', '{b1000000-0000-4000-8000-000000000001}');
insert into public.quiz_attempts (id, user_id, quiz_id, status, started_at, device_id) values
  ('a9000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a8000000-0000-4000-8000-000000000001', 'in_progress', now(), 'dev-a'),
  ('a9000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'a8000000-0000-4000-8000-000000000002', 'in_progress', now(), 'dev-b');
insert into public.attempt_answers (id, attempt_id, user_id, question_id, question_version, response, correct, confidence, answered_at) values
  ('aa000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b1000000-0000-4000-8000-000000000003', 1, '{"choice":"b"}', false, 3, now()),
  ('aa000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'b1000000-0000-4000-8000-000000000001', 1, '{"choice":"a"}', true, 4, now());
insert into public.mistakes (id, user_id, question_id, attempt_answer_id, subject_id, node_id, cause, suggested_cause) values
  ('ab000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b1000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'didnt_know', 'didnt_know');
insert into public.mastery (user_id, node_id, subject_id, mastery) values
  ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 0.5);
insert into public.mastery_evidence (user_id, node_id, subject_id, source, outcome, weight, ref_type, ref_id, occurred_at) values
  ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'quiz_answer', 0, 1, 'attempt_answer', 'aa000000-0000-4000-8000-000000000001', now());

-- Tutor thread and message of alice.
insert into public.tutor_threads (id, user_id, scope_type, subject_id, title) values
  ('ae000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'subject', 'a0000000-0000-4000-8000-000000000001', 'Duvida');
insert into public.tutor_messages (id, thread_id, user_id, role, content, mode) values
  ('af000000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'assistant', 'Oi', 'answer');

-- Planning and predictions: readiness of alice, teacher profile of the Turma subject, a prediction on e_alice.
insert into public.readiness_snapshots (user_id, exam_id, local_date, readiness) values
  ('11111111-1111-4111-8111-111111111111', 'a2000000-0000-4000-8000-000000000001', (now() at time zone 'America/Sao_Paulo')::date, 0.5);
insert into public.plan_coach (user_id, local_date, signals_hash, output, prompt_version, calls_date) values
  ('11111111-1111-4111-8111-111111111111', (now() at time zone 'America/Sao_Paulo')::date, 'h', '{"headline":"x"}', 'plan.coach@v1', (now() at time zone 'America/Sao_Paulo')::date);
insert into public.teacher_profiles (id, subject_id, teacher_key, teacher_display, confidence) values
  ('b3000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'prof-x', 'Prof X', 'mid');
insert into public.topic_predictions (id, target_type, target_id, node_id, weight) values
  ('b4000000-0000-4000-8000-000000000001', 'exam', 'a2000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 0.5);

-- =====================================================================
-- 0. Every Phase 1 table has row level security on (testing-strategy.md §4)
-- =====================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind = 'r'
      and c.relname = any(array['content_flags','notes','note_highlights','topic_reads','glossary_terms',
        'glossary_term_overrides','explanations','explanation_feedback','card_overrides','concept_contrasts',
        'item_revisions','item_hides','mastery','mastery_evidence','essays','quizzes','quiz_attempts',
        'attempt_answers','mistakes','exam_scope_items','exam_scope_nodes','grading_rules','grade_components',
        'study_sessions','availability_exceptions','desperate_modes','readiness_snapshots','teacher_profiles',
        'topic_predictions','exam_outcome_topics','tutor_threads','tutor_messages','join_attempts'])
      and c.relrowsecurity),
  33, 'all 33 Phase 1 tables have row level security enabled');

-- =====================================================================
-- 1. notes and highlights (LRN-01): members read the Turma's notes, nobody but the service writes them
-- =====================================================================
select test_helpers.check_rows('bob (member) reads the Turma note', 'authenticated', pg_temp.u('bob'),
  $$select id from public.notes$$, 1);
select test_helpers.check_rows('dave (outsider) reads no notes', 'authenticated', pg_temp.u('dave'),
  $$select id from public.notes$$, 0);
select test_helpers.check_rows('bob cannot read alice personal note', 'authenticated', pg_temp.u('bob'),
  $$select id from public.notes where id = '41000000-0000-4000-8000-000000000002'$$, 0);
select test_helpers.check_err('a member cannot update a note (service only)', 'authenticated', pg_temp.u('bob'),
  $$update public.notes set body = 'x'$$);
select test_helpers.check_err('a member cannot create a note (service only)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.notes (subject_id, node_id, depth, language, created_by) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'tldr', 'pt-BR', '22222222-2222-4222-8222-222222222222')$$);
select test_helpers.check_rows('bob highlights the Turma note', 'authenticated', pg_temp.u('bob'),
  $$insert into public.note_highlights (id, user_id, note_id, "start", "end", quote, color) values ('e1000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '41000000-0000-4000-8000-000000000001', 0, 5, 'Resumo', 'yellow')$$, 1);
select test_helpers.check_err('bob cannot highlight as alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.note_highlights (user_id, note_id, "start", "end", quote, color) values ('11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001', 0, 5, 'x', 'green')$$);
select test_helpers.check_err('dave cannot highlight a note he cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.note_highlights (user_id, note_id, "start", "end", quote, color) values ('44444444-4444-4444-8444-444444444444', '41000000-0000-4000-8000-000000000001', 0, 5, 'x', 'green')$$);
select test_helpers.check_sqlstate('highlight colors are limited to the four documented values',
  $$insert into public.note_highlights (user_id, note_id, "start", "end", quote, color) values ('22222222-2222-4222-8222-222222222222', '41000000-0000-4000-8000-000000000001', 0, 5, 'x', 'red')$$, '23514');
select test_helpers.check_rows('bob updates his highlight', 'authenticated', pg_temp.u('bob'),
  $$update public.note_highlights set orphaned = true where id = 'e1000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('alice cannot read bob highlights', 'authenticated', pg_temp.u('alice'),
  $$select id from public.note_highlights$$, 0);

-- =====================================================================
-- 2. topic_reads (append-only, LRN-01.11)
-- =====================================================================
select test_helpers.check_rows('bob records a topic read', 'authenticated', pg_temp.u('bob'),
  $$insert into public.topic_reads (id, user_id, node_id, depth, read_at, seconds) values ('e2000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '40000000-0000-4000-8000-000000000002', 'study', now(), 30)$$, 1);
select test_helpers.check_err('topic reads cannot be updated by clients', 'authenticated', pg_temp.u('bob'),
  $$update public.topic_reads set seconds = 1$$);
select test_helpers.check_err('topic reads cannot be deleted by clients', 'authenticated', pg_temp.u('bob'),
  $$delete from public.topic_reads$$);
select test_helpers.check_rows('alice cannot read bob topic reads', 'authenticated', pg_temp.u('alice'),
  $$select id from public.topic_reads$$, 0);
select test_helpers.check_sqlstate('topic reads are append-only (forbid_mutation)',
  $$update public.topic_reads set seconds = 1 where id = 'e2000000-0000-4000-8000-000000000001'$$, '42501');

-- =====================================================================
-- 3. glossary (LRN-02): readable with the subject, overrides are per user
-- =====================================================================
select test_helpers.check_scalar('the normalized term is lowercase and unaccented', 'authenticated', pg_temp.u('bob'),
  $$select normalized_term from public.glossary_terms where id = '42000000-0000-4000-8000-000000000001'$$, 'funcao afim');
select test_helpers.check_rows('bob reads the Turma glossary', 'authenticated', pg_temp.u('bob'),
  $$select id from public.glossary_terms$$, 1);
select test_helpers.check_rows('dave reads no glossary', 'authenticated', pg_temp.u('dave'),
  $$select id from public.glossary_terms$$, 0);
select test_helpers.check_err('a member cannot add a glossary term', 'authenticated', pg_temp.u('bob'),
  $$insert into public.glossary_terms (subject_id, term) values ('50000000-0000-4000-8000-000000000001', 'Novo')$$);
select test_helpers.check_rows('bob overrides a glossary definition for himself', 'authenticated', pg_temp.u('bob'),
  $$insert into public.glossary_term_overrides (user_id, term_id, definition) values ('22222222-2222-4222-8222-222222222222', '42000000-0000-4000-8000-000000000001', 'minha definicao')$$, 1);
select test_helpers.check_rows('bob updates his override', 'authenticated', pg_temp.u('bob'),
  $$update public.glossary_term_overrides set definition = 'outra' where term_id = '42000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('alice cannot read bob override', 'authenticated', pg_temp.u('alice'),
  $$select term_id from public.glossary_term_overrides$$, 0);
select test_helpers.check_err('dave cannot override a term he cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.glossary_term_overrides (user_id, term_id, definition) values ('44444444-4444-4444-8444-444444444444', '42000000-0000-4000-8000-000000000001', 'x')$$);

-- =====================================================================
-- 4. explanations (LRN-03, R8): shared cache for the subject, personal ones for their owner only
-- =====================================================================
select test_helpers.check_rows('bob reads the shared and his personal explanation', 'authenticated', pg_temp.u('bob'),
  $$select id from public.explanations$$, 2);
select test_helpers.check_rows('alice reads only the shared explanation', 'authenticated', pg_temp.u('alice'),
  $$select id from public.explanations$$, 1);
select test_helpers.check_rows('dave reads no explanations', 'authenticated', pg_temp.u('dave'),
  $$select id from public.explanations$$, 0);
select test_helpers.check_rows('alice cannot read bob personal explanation', 'authenticated', pg_temp.u('alice'),
  $$select id from public.explanations where id = '43000000-0000-4000-8000-000000000002'$$, 0);
select test_helpers.check_rows('bob saves his personal explanation', 'authenticated', pg_temp.u('bob'),
  $$update public.explanations set saved = true where id = '43000000-0000-4000-8000-000000000002'$$, 1);
select test_helpers.check_rows('bob cannot save a shared explanation', 'authenticated', pg_temp.u('bob'),
  $$update public.explanations set saved = true where id = '43000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('bob cannot rewrite an explanation body', 'authenticated', pg_temp.u('bob'),
  $$update public.explanations set body = 'x' where id = '43000000-0000-4000-8000-000000000002'$$);

-- =====================================================================
-- 5. explanation feedback (append-only, LRN-03.4)
-- =====================================================================
select test_helpers.check_rows('bob rates the shared explanation', 'authenticated', pg_temp.u('bob'),
  $$insert into public.explanation_feedback (id, user_id, explanation_id, helpful) values ('e3000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '43000000-0000-4000-8000-000000000001', true)$$, 1);
select test_helpers.check_err('dave cannot rate an explanation he cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.explanation_feedback (user_id, explanation_id, helpful) values ('44444444-4444-4444-8444-444444444444', '43000000-0000-4000-8000-000000000001', true)$$);
select test_helpers.check_err('feedback cannot be changed by clients', 'authenticated', pg_temp.u('bob'),
  $$update public.explanation_feedback set helpful = false$$);
select test_helpers.check_sqlstate('feedback is append-only (forbid_mutation)',
  $$update public.explanation_feedback set helpful = false where id = 'e3000000-0000-4000-8000-000000000001'$$, '42501');

-- =====================================================================
-- 6. card overrides (MEM-01) and concept contrasts (PRA-04)
-- =====================================================================
select test_helpers.check_rows('bob overrides a shared card for himself', 'authenticated', pg_temp.u('bob'),
  $$insert into public.card_overrides (user_id, card_id, front) values ('22222222-2222-4222-8222-222222222222', 'c0000000-0000-4000-8000-000000000001', 'Minha frente')$$, 1);
select test_helpers.check_rows('bob updates his card override', 'authenticated', pg_temp.u('bob'),
  $$update public.card_overrides set back = 'Meu verso' where card_id = 'c0000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('alice cannot read bob card overrides', 'authenticated', pg_temp.u('alice'),
  $$select card_id from public.card_overrides$$, 0);
select test_helpers.check_err('dave cannot override a card he cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.card_overrides (user_id, card_id, front) values ('44444444-4444-4444-8444-444444444444', 'c0000000-0000-4000-8000-000000000001', 'x')$$);
select test_helpers.check_sqlstate('a concept contrast needs concept_a < concept_b',
  $$insert into public.concept_contrasts (subject_id, concept_a_id, concept_b_id, content) values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', '{}')$$, '23514');
insert into public.concept_contrasts (id, subject_id, concept_a_id, concept_b_id, content) values
  ('e4000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', '{"a":"reta","b":"parabola"}');
select test_helpers.check_rows('members read the Turma contrasts', 'authenticated', pg_temp.u('bob'),
  $$select id from public.concept_contrasts$$, 1);
select test_helpers.check_rows('dave reads no contrasts', 'authenticated', pg_temp.u('dave'),
  $$select id from public.concept_contrasts$$, 0);
select test_helpers.check_err('a member cannot write a contrast', 'authenticated', pg_temp.u('bob'),
  $$delete from public.concept_contrasts$$);

-- =====================================================================
-- 7. item_hides (R7) and content flags (TRU-02)
-- =====================================================================
select test_helpers.check_sqlstate('item_hides never takes card (R7)',
  $$insert into public.item_hides (user_id, item_type, item_id, reason) values ('22222222-2222-4222-8222-222222222222', 'card', 'c0000000-0000-4000-8000-000000000001', 'wrong')$$, '23514');
select test_helpers.check_rows('bob hides a shared question for himself', 'authenticated', pg_temp.u('bob'),
  $$insert into public.item_hides (user_id, item_type, item_id, reason) values ('22222222-2222-4222-8222-222222222222', 'question', 'b1000000-0000-4000-8000-000000000001', 'not_useful')$$, 1);
select test_helpers.check_rows('bob unhides it (soft delete)', 'authenticated', pg_temp.u('bob'),
  $$update public.item_hides set deleted_at = now() where item_id = 'b1000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot hide bob personal question', 'authenticated', pg_temp.u('alice'),
  $$insert into public.item_hides (user_id, item_type, item_id, reason) values ('11111111-1111-4111-8111-111111111111', 'question', 'b1000000-0000-4000-8000-000000000002', 'wrong')$$);
select test_helpers.check_rows('alice reads no hides of bob', 'authenticated', pg_temp.u('alice'),
  $$select item_id from public.item_hides$$, 0);

select test_helpers.check_rows('bob flags a shared question', 'authenticated', pg_temp.u('bob'),
  $$insert into public.content_flags (id, item_type, item_id, item_version, class_group_id, reporter_id, reason)
    values ('b5000000-0000-4000-8000-000000000009', 'knowledge_node', '40000000-0000-4000-8000-000000000002', 1, '77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'unclear')$$, 1);
select test_helpers.check_err('a flag must name the Turma that owns the item', 'authenticated', pg_temp.u('bob'),
  $$insert into public.content_flags (item_type, item_id, item_version, reporter_id, reason)
    values ('question', 'b1000000-0000-4000-8000-000000000001', 1, '22222222-2222-4222-8222-222222222222', 'unclear')$$);
select test_helpers.check_err('dave cannot flag an item of a Turma he is not in', 'authenticated', pg_temp.u('dave'),
  $$insert into public.content_flags (item_type, item_id, item_version, class_group_id, reporter_id, reason)
    values ('question', 'b1000000-0000-4000-8000-000000000001', 1, '77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'unclear')$$);
select test_helpers.check_rows('carol (moderator) reads the Turma flags', 'authenticated', pg_temp.u('carol'),
  $$select id from public.content_flags$$, 4);
select test_helpers.check_rows('bob reads only his own flags', 'authenticated', pg_temp.u('bob'),
  $$select id from public.content_flags$$, 2);
select test_helpers.check_err('clients cannot resolve a flag by update', 'authenticated', pg_temp.u('carol'),
  $$update public.content_flags set status = 'accepted'$$);

-- =====================================================================
-- 8. mastery (service writes, pull only) and mastery evidence (append-only)
-- =====================================================================
select test_helpers.check_rows('alice reads her mastery', 'authenticated', pg_temp.u('alice'),
  $$select node_id from public.mastery$$, 1);
select test_helpers.check_rows('bob reads no mastery of alice', 'authenticated', pg_temp.u('bob'),
  $$select node_id from public.mastery$$, 0);
select test_helpers.check_err('clients cannot write mastery', 'authenticated', pg_temp.u('alice'),
  $$update public.mastery set mastery = 1$$);
select test_helpers.check_rows('alice reads her mastery evidence', 'authenticated', pg_temp.u('alice'),
  $$select id from public.mastery_evidence$$, 1);
select test_helpers.check_rows('bob reads no mastery evidence of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.mastery_evidence$$, 0);
select test_helpers.check_err('clients cannot add evidence', 'authenticated', pg_temp.u('alice'),
  $$insert into public.mastery_evidence (user_id, node_id, subject_id, source, outcome, weight, ref_type, ref_id, occurred_at)
    values ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'review', 1, 1, 'review_log', gen_random_uuid(), now())$$);
select test_helpers.check_sqlstate('mastery evidence is append-only (forbid_mutation)',
  $$update public.mastery_evidence set outcome = 1$$, '42501');

-- =====================================================================
-- 9. essays (PRA-07, school_answer): own drafts, grading columns written by the service
-- =====================================================================
select test_helpers.check_rows('alice writes a school answer', 'authenticated', pg_temp.u('alice'),
  $$insert into public.essays (id, user_id, kind, text) values ('e5000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'school_answer', 'Minha resposta')$$, 1);
select test_helpers.check_rows('alice edits her draft', 'authenticated', pg_temp.u('alice'),
  $$update public.essays set text = 'Resposta revisada' where id = 'e5000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot set the grade of her essay', 'authenticated', pg_temp.u('alice'),
  $$update public.essays set status = 'graded', total = 900 where id = 'e5000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('alice cannot write an essay for bob', 'authenticated', pg_temp.u('alice'),
  $$insert into public.essays (user_id, kind) values ('22222222-2222-4222-8222-222222222222', 'school_answer')$$);
select test_helpers.check_rows('bob reads no essays of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.essays$$, 0);

-- =====================================================================
-- 10. quizzes, attempts, answers, mistakes (PRA-01…04)
-- =====================================================================
select test_helpers.check_rows('alice reads her quiz', 'authenticated', pg_temp.u('alice'),
  $$select id from public.quizzes$$, 1);
select test_helpers.check_rows('bob reads only his quiz', 'authenticated', pg_temp.u('bob'),
  $$select id from public.quizzes$$, 1);
select test_helpers.check_err('alice cannot create a quiz owned by bob', 'authenticated', pg_temp.u('alice'),
  $$insert into public.quizzes (owner_id, kind) values ('22222222-2222-4222-8222-222222222222', 'practice')$$);
select test_helpers.check_err('clients cannot create predicted tests (Edge only)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.quizzes (owner_id, kind) values ('11111111-1111-4111-8111-111111111111', 'predicted_test')$$);
select test_helpers.check_rows('alice starts an attempt on her practice quiz', 'authenticated', pg_temp.u('alice'),
  $$insert into public.quiz_attempts (id, user_id, quiz_id, status, started_at, device_id) values ('e6000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a8000000-0000-4000-8000-000000000001', 'in_progress', now(), 'dev-a2')$$, 1);
select test_helpers.check_err('alice cannot start an attempt on bob quiz', 'authenticated', pg_temp.u('alice'),
  $$insert into public.quiz_attempts (user_id, quiz_id, status, started_at, device_id) values ('11111111-1111-4111-8111-111111111111', 'a8000000-0000-4000-8000-000000000002', 'in_progress', now(), 'dev-a')$$);
select test_helpers.check_err('alice cannot submit an attempt directly (quiz-submit scores it)', 'authenticated', pg_temp.u('alice'),
  $$update public.quiz_attempts set status = 'submitted' where id = 'a9000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('alice abandons her open attempt', 'authenticated', pg_temp.u('alice'),
  $$update public.quiz_attempts set status = 'abandoned' where id = 'e6000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob reads no attempts of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.quiz_attempts where user_id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_rows('alice answers in her open attempt', 'authenticated', pg_temp.u('alice'),
  $$insert into public.attempt_answers (id, attempt_id, user_id, question_id, question_version, response, confidence, time_spent_ms, answered_at) values ('e7000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b1000000-0000-4000-8000-000000000001', 1, '{"choice":"c"}', 2, 1200, now())$$, 1);
select test_helpers.check_err('alice cannot answer in bob attempt', 'authenticated', pg_temp.u('alice'),
  $$insert into public.attempt_answers (attempt_id, user_id, question_id, question_version, answered_at) values ('a9000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'b1000000-0000-4000-8000-000000000001', 1, now())$$);
select test_helpers.check_err('alice cannot mark her own answer correct', 'authenticated', pg_temp.u('alice'),
  $$update public.attempt_answers set correct = true where id = 'aa000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob reads no answers of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.attempt_answers where user_id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_rows('alice reads her mistake', 'authenticated', pg_temp.u('alice'),
  $$select id from public.mistakes$$, 1);
select test_helpers.check_rows('alice adds a note to her mistake', 'authenticated', pg_temp.u('alice'),
  $$update public.mistakes set user_note = 'Confundi as organelas' where id = 'ab000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('bob reads no mistakes of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.mistakes$$, 0);
select test_helpers.check_scalar('calibration_stats is a security invoker view', 'authenticated', pg_temp.u('alice'),
  $$(select count(*) from pg_class c where c.relname = 'calibration_stats' and c.reloptions @> array['security_invoker=true'])$$, '1');
select test_helpers.check_scalar('alice sees her calibration row (confidence 3, wrong)', 'authenticated', pg_temp.u('alice'),
  $$(select n || ':' || n_correct from public.calibration_stats where confidence = 3)$$, '1:0');
select test_helpers.check_scalar('bob sees no calibration rows of alice', 'authenticated', pg_temp.u('bob'),
  $$(select count(*) from public.calibration_stats where user_id = '11111111-1111-4111-8111-111111111111')$$, '0');

-- =====================================================================
-- 11. goals: scope, grading, study sessions, availability (GOL-03, GOL-04, GOL-05, GOL-06)
-- =====================================================================
select test_helpers.check_rows('alice adds a scope item to her exam', 'authenticated', pg_temp.u('alice'),
  $$insert into public.exam_scope_items (id, exam_id, raw_text) values ('e8000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Celulas')$$, 1);
select test_helpers.check_err('bob cannot add a scope item to alice exam', 'authenticated', pg_temp.u('bob'),
  $$insert into public.exam_scope_items (exam_id, raw_text) values ('a2000000-0000-4000-8000-000000000001', 'x')$$);
select test_helpers.check_rows('bob reads no scope items of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.exam_scope_items$$, 0);
select test_helpers.check_rows('alice scopes her exam to a topic of her subject', 'authenticated', pg_temp.u('alice'),
  $$insert into public.exam_scope_nodes (exam_id, node_id, source, confirmed) values ('a2000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'user', true)$$, 1);
select test_helpers.check_rows('alice reads her grading rule', 'authenticated', pg_temp.u('alice'),
  $$select id from public.grading_rules$$, 1);
select test_helpers.check_err('bob cannot write a grading rule for alice', 'authenticated', pg_temp.u('bob'),
  $$insert into public.grading_rules (owner_profile_id, school_year, formula) values ('11111111-1111-4111-8111-111111111111', 3, '{}')$$);
select test_helpers.check_rows('alice reads her grade components', 'authenticated', pg_temp.u('alice'),
  $$select id from public.grade_components$$, 3);
select test_helpers.check_rows('bob reads no grades of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.grade_components$$, 0);
select test_helpers.check_rows('alice starts a study session (client id)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.study_sessions (id, user_id, kind, started_at, active_minutes) values ('e9000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'review', now(), 12)$$, 1);
select test_helpers.check_err('a study session kind is limited to R17', 'authenticated', pg_temp.u('alice'),
  $$insert into public.study_sessions (user_id, kind, started_at) values ('11111111-1111-4111-8111-111111111111', 'gaming', now())$$);
select test_helpers.check_rows('alice reduces the minutes of a day (own)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.availability_exceptions (user_id, local_date, minutes, source) values ('11111111-1111-4111-8111-111111111111', '2026-06-01', 0, 'user')$$, 1);
select test_helpers.check_err('clients cannot write desperate availability rows', 'authenticated', pg_temp.u('alice'),
  $$insert into public.availability_exceptions (user_id, local_date, minutes, source) values ('11111111-1111-4111-8111-111111111111', '2026-06-02', 60, 'desperate')$$);
select test_helpers.check_rows('alice reads her readiness', 'authenticated', pg_temp.u('alice'),
  $$select exam_id from public.readiness_snapshots$$, 1);
select test_helpers.check_rows('bob reads no readiness of alice', 'authenticated', pg_temp.u('bob'),
  $$select exam_id from public.readiness_snapshots$$, 0);
select test_helpers.check_err('clients cannot write readiness', 'authenticated', pg_temp.u('alice'),
  $$insert into public.readiness_snapshots (user_id, exam_id, local_date, readiness) values ('11111111-1111-4111-8111-111111111111', 'a2000000-0000-4000-8000-000000000001', '2026-06-01', 0.1)$$);
select test_helpers.check_rows('alice reads her plan coach', 'authenticated', pg_temp.u('alice'),
  $$select user_id from public.plan_coach$$, 1);
select test_helpers.check_rows('bob reads no plan coach of alice', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.plan_coach$$, 0);
select test_helpers.check_err('clients cannot write the plan coach', 'authenticated', pg_temp.u('alice'),
  $$update public.plan_coach set signals_hash = 'x' where user_id = '11111111-1111-4111-8111-111111111111'$$);
select test_helpers.check_err('clients cannot read topic study estimates (service only)', 'authenticated', pg_temp.u('alice'),
  $$select node_id from public.topic_study_estimates$$);
select test_helpers.check_rows('members read the Turma teacher profile', 'authenticated', pg_temp.u('bob'),
  $$select id from public.teacher_profiles$$, 1);
select test_helpers.check_rows('dave reads no teacher profile', 'authenticated', pg_temp.u('dave'),
  $$select id from public.teacher_profiles$$, 0);
select test_helpers.check_rows('alice reads the prediction of her exam', 'authenticated', pg_temp.u('alice'),
  $$select id from public.topic_predictions$$, 1);
select test_helpers.check_rows('bob reads no predictions', 'authenticated', pg_temp.u('bob'),
  $$select id from public.topic_predictions$$, 0);
select test_helpers.check_rows('alice records an outcome topic of her exam', 'authenticated', pg_temp.u('alice'),
  $$insert into public.exam_outcome_topics (exam_id, user_id, node_id) values ('a2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002')$$, 1);
select test_helpers.check_rows('bob reads no outcome topics', 'authenticated', pg_temp.u('bob'),
  $$select exam_id from public.exam_outcome_topics$$, 0);

-- =====================================================================
-- 12. tutor (TUT-01…06): threads are own; the service writes the messages
-- =====================================================================
select test_helpers.check_rows('alice reads her thread', 'authenticated', pg_temp.u('alice'),
  $$select id from public.tutor_threads$$, 1);
select test_helpers.check_rows('bob reads no tutor threads of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.tutor_threads$$, 0);
select test_helpers.check_rows('alice starts a thread on her subject', 'authenticated', pg_temp.u('alice'),
  $$insert into public.tutor_threads (id, user_id, scope_type, subject_id, title) values ('ea000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'subject', 'a0000000-0000-4000-8000-000000000001', 'Nova')$$, 1);
select test_helpers.check_err('a thread scope must name its column (topic needs a node)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.tutor_threads (user_id, scope_type, title) values ('11111111-1111-4111-8111-111111111111', 'topic', 'Sem topico')$$);
select test_helpers.check_err('alice cannot open a thread for bob', 'authenticated', pg_temp.u('alice'),
  $$insert into public.tutor_threads (user_id, scope_type, subject_id) values ('22222222-2222-4222-8222-222222222222', 'subject', 'a0000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_rows('alice archives a thread (never a delete)', 'authenticated', pg_temp.u('alice'),
  $$update public.tutor_threads set archived_at = now() where id = 'ea000000-0000-4000-8000-000000000002'$$, 1);
select test_helpers.check_rows('alice reads her tutor message', 'authenticated', pg_temp.u('alice'),
  $$select id from public.tutor_messages$$, 1);
select test_helpers.check_rows('alice rates a tutor answer', 'authenticated', pg_temp.u('alice'),
  $$update public.tutor_messages set feedback = 1 where id = 'af000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot rewrite a tutor answer', 'authenticated', pg_temp.u('alice'),
  $$update public.tutor_messages set content = 'x' where id = 'af000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('clients cannot insert tutor messages (Edge only)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.tutor_messages (thread_id, user_id, role, mode) values ('ae000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'user', 'answer')$$);
select test_helpers.check_rows('bob reads no tutor messages of alice', 'authenticated', pg_temp.u('bob'),
  $$select id from public.tutor_messages$$, 0);

-- =====================================================================
-- 13. realtime (data-model §8.1): notes and essays are published
-- =====================================================================
select is(
  (select count(*)::int from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('notes','essays')),
  2, 'notes and essays are in the supabase_realtime publication');

-- =====================================================================
-- 14. edit_outline: merge, split, restore and their undo (ING-04.3, .4, .5)
-- =====================================================================
select test_helpers.check_err('bob (member) cannot restructure the Turma map', 'authenticated', pg_temp.u('bob'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"merge","node_ids":["40000000-0000-4000-8000-000000000002","40000000-0000-4000-8000-000000000004"]}]'::jsonb)$$);
select test_helpers.check_err('merge only joins topics (a unit is refused)', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"merge","node_ids":["40000000-0000-4000-8000-000000000001","40000000-0000-4000-8000-000000000004"]}]'::jsonb)$$);
select test_helpers.check_ok('carol merges two topics (keeps the first id)', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"merge","node_ids":["40000000-0000-4000-8000-000000000002","40000000-0000-4000-8000-000000000004"]}]'::jsonb)$$);
select is((select count(*)::int from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000004' and deleted_at is not null),
  1, 'the merged topic is a tombstone');
select is((select count(*)::int from public.node_sources where node_id = '40000000-0000-4000-8000-000000000002' and deleted_at is null),
  2, 'the kept topic now has the union of both topics sources');
select is((select status from public.notes where id = '41000000-0000-4000-8000-000000000001'),
  'superseded', 'the notes of the merged topics are archived for regeneration');
select test_helpers.check_ok('carol undoes the merge within 30 days', 'authenticated', pg_temp.u('carol'),
  $$select public.undo_outline_event((select id from public.node_events where action = 'merge' order by created_at desc limit 1))$$);
select is((select count(*)::int from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000004' and deleted_at is null),
  1, 'undo restores the merged topic');
select is((select count(*)::int from public.node_sources where node_id = '40000000-0000-4000-8000-000000000002' and deleted_at is null),
  1, 'undo gives its sources back');
select is((select status from public.notes where id = '41000000-0000-4000-8000-000000000001'),
  'ready', 'undo restores the note status');

select test_helpers.check_ok('carol splits the topic before page 3', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"split","node_id":"40000000-0000-4000-8000-000000000002","page":3}]'::jsonb)$$);
select is((select count(*)::int from public.node_sources where page_start = 3 and page_end = 4 and deleted_at is null),
  1, 'the second part gets the straddling source from page 3');
select is((select node_id = '40000000-0000-4000-8000-000000000002' from public.cards where id = 'c0000000-0000-4000-8000-000000000004'),
  false, 'the item whose first page is 4 moves to the new topic');
select is((select parent_id from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000003'),
  '40000000-0000-4000-8000-000000000002'::uuid, 'a concept without sources stays with its topic');
select test_helpers.check_ok('carol undoes the split', 'authenticated', pg_temp.u('carol'),
  $$select public.undo_outline_event((select id from public.node_events where action = 'split' order by created_at desc limit 1))$$);
select is((select node_id from public.cards where id = 'c0000000-0000-4000-8000-000000000004'),
  '40000000-0000-4000-8000-000000000002'::uuid, 'undo moves the item back');
select is((select page_end from public.node_sources where node_id = '40000000-0000-4000-8000-000000000002' and deleted_at is null),
  4, 'undo restores the shortened source');

select test_helpers.check_ok('carol deletes the second topic (soft, with its subtree)', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"delete","node_id":"40000000-0000-4000-8000-000000000004"}]'::jsonb)$$);
select test_helpers.check_ok('carol restores it from the deleted items', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"restore","node_id":"40000000-0000-4000-8000-000000000004"}]'::jsonb)$$);
select is((select count(*)::int from public.knowledge_nodes where id = '40000000-0000-4000-8000-000000000004' and deleted_at is null),
  1, 'restore brings the topic back');
select test_helpers.check_err('a live node cannot be restored', 'authenticated', pg_temp.u('carol'),
  $$select public.edit_outline('50000000-0000-4000-8000-000000000001', '[{"op":"restore","node_id":"40000000-0000-4000-8000-000000000004"}]'::jsonb)$$);

-- =====================================================================
-- 15. handle_report: remove_content (SP-09)
-- =====================================================================
select test_helpers.check_err('remove_content needs content in the report', 'authenticated', pg_temp.u('carol'),
  $$select public.handle_report('f2000000-0000-4000-8000-000000000002', 'remove_content')$$);
select test_helpers.check_err('remove_content cannot reach personal content outside the Turma', 'authenticated', pg_temp.u('carol'),
  $$select public.handle_report('f2000000-0000-4000-8000-000000000003', 'remove_content')$$);
select test_helpers.check_err('bob cannot handle reports', 'authenticated', pg_temp.u('bob'),
  $$select public.handle_report('f2000000-0000-4000-8000-000000000001', 'remove_content')$$);
select test_helpers.check_ok('carol removes the reported card', 'authenticated', pg_temp.u('carol'),
  $$select public.handle_report('f2000000-0000-4000-8000-000000000001', 'remove_content')$$);
select test_helpers.check_rows('bob cannot see the removed card', 'authenticated', pg_temp.u('bob'),
  $$select id from public.cards where id = 'c0000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('carol (moderator) still sees the removed card', 'authenticated', pg_temp.u('carol'),
  $$select id from public.cards where id = 'c0000000-0000-4000-8000-000000000001'$$, 1);
select is((select status from public.user_reports where id = 'f2000000-0000-4000-8000-000000000001'),
  'actioned', 'the report is marked actioned');
select is((select count(*)::int from private.moderation_actions where action = 'remove' and report_id = 'f2000000-0000-4000-8000-000000000001'),
  1, 'the removal is logged in the moderation trail');

-- =====================================================================
-- 16. join_class_group rate limit (SOC-01.14): 5 failed codes per hour
-- =====================================================================
select test_helpers.check_scalar('frank joins Turma A with the code and waits for approval', 'authenticated', pg_temp.u('frank'),
  $$public.join_class_group('ABCD2345')->>'status'$$, 'pending');
select test_helpers.check_ok('the service records 5 failed codes for frank', 'service_role', null,
  $$select public.record_join_failure('66666666-6666-4666-8666-666666666666') from generate_series(1, 5)$$);
select test_helpers.check_err('clients cannot record join failures', 'authenticated', pg_temp.u('frank'),
  $$select public.record_join_failure('66666666-6666-4666-8666-666666666666')$$);
select test_helpers.check_err('after 5 failed codes in an hour joining is rate limited', 'authenticated', pg_temp.u('frank'),
  $$select public.join_class_group('ABCD2345')$$);

-- =====================================================================
-- 18. Modo Desespero (GOL-12): start, groups, end
-- =====================================================================
select test_helpers.check_err('a test 30 days away is not in the 7-day window', 'authenticated', pg_temp.u('alice'),
  $$select public.start_desperate_mode('a1000000-0000-4000-8000-000000000001', '{a2000000-0000-4000-8000-000000000003}', 120)$$);
select test_helpers.check_err('minutes per day must be 60-240', 'authenticated', pg_temp.u('alice'),
  $$select public.start_desperate_mode('a1000000-0000-4000-8000-000000000001', '{a2000000-0000-4000-8000-000000000001}', 30)$$);
select test_helpers.check_ok('alice starts the mode for her two near tests', 'authenticated', pg_temp.u('alice'),
  $$select public.start_desperate_mode('a1000000-0000-4000-8000-000000000001', '{a2000000-0000-4000-8000-000000000001,a2000000-0000-4000-8000-000000000002}', 120)$$);
select is((select count(*)::int from public.availability_exceptions where user_id = '11111111-1111-4111-8111-111111111111' and source = 'desperate' and deleted_at is null),
  6, 'the chosen time covers each day up to the last test (today to +5)');
select test_helpers.check_err('only one active mode per goal', 'authenticated', pg_temp.u('alice'),
  $$select public.start_desperate_mode('a1000000-0000-4000-8000-000000000001', '{a2000000-0000-4000-8000-000000000001}', 120)$$);
select test_helpers.check_err('bob cannot start a mode on the goal of alice', 'authenticated', pg_temp.u('bob'),
  $$select public.start_desperate_mode('a1000000-0000-4000-8000-000000000001', '{a2000000-0000-4000-8000-000000000001}', 120)$$);
select test_helpers.check_ok('alice moves a topic of her subject to Foco total', 'authenticated', pg_temp.u('alice'),
  $$select public.set_desperate_groups((select id from public.desperate_modes where status = 'active'), '[{"node_id":"a7000000-0000-4000-8000-000000000002","group":"focus"}]'::jsonb)$$);
select test_helpers.check_scalar('the topic group is stored', 'authenticated', pg_temp.u('alice'),
  $$(select topic_groups->>'a7000000-0000-4000-8000-000000000002' from public.desperate_modes where status = 'active')$$, 'focus');
select test_helpers.check_err('a group must be focus, basic or out', 'authenticated', pg_temp.u('alice'),
  $$select public.set_desperate_groups((select id from public.desperate_modes where status = 'active'), '[{"node_id":"a7000000-0000-4000-8000-000000000002","group":"maybe"}]'::jsonb)$$);
select test_helpers.check_err('a topic outside the exams subjects is refused', 'authenticated', pg_temp.u('alice'),
  $$select public.set_desperate_groups((select id from public.desperate_modes where status = 'active'), '[{"node_id":"40000000-0000-4000-8000-000000000002","group":"focus"}]'::jsonb)$$);
select test_helpers.check_ok('alice ends the mode', 'authenticated', pg_temp.u('alice'),
  $$select public.end_desperate_mode((select id from public.desperate_modes where status = 'active'))$$);
select is((select count(*)::int from public.availability_exceptions where user_id = '11111111-1111-4111-8111-111111111111' and source = 'desperate' and deleted_at is null),
  0, 'ending the mode removes its future availability rows');
select test_helpers.check_err('a mode cannot be ended twice', 'authenticated', pg_temp.u('alice'),
  $$select public.end_desperate_mode((select id from public.desperate_modes limit 1))$$);

-- =====================================================================
-- 17. confirm_exam_scope (GOL-03) and log_exam_grade (GOL-06)
-- =====================================================================
select test_helpers.check_ok('alice confirms the unit of her exam', 'authenticated', pg_temp.u('alice'),
  $$select public.confirm_exam_scope('a2000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000001}', false)$$);
select is((select count(*)::int from public.exam_scope_nodes where exam_id = 'a2000000-0000-4000-8000-000000000001' and deleted_at is null and confirmed),
  1, 'the confirmed scope of the exam is the chosen unit');
select test_helpers.check_ok('nodes of another subject are left out of the scope', 'authenticated', pg_temp.u('alice'),
  $$select public.confirm_exam_scope('a2000000-0000-4000-8000-000000000001', '{40000000-0000-4000-8000-000000000002}', false)$$);
select is((select count(*)::int from public.exam_scope_nodes where exam_id = 'a2000000-0000-4000-8000-000000000001' and deleted_at is null),
  0, 'the replaced scope has no live row left from the other subject');
select test_helpers.check_ok('alice confirms the whole subject for her second exam (default_all)', 'authenticated', pg_temp.u('alice'),
  $$select public.confirm_exam_scope('a2000000-0000-4000-8000-000000000002', '{}', true)$$);
select is((select source from public.exam_scope_nodes where exam_id = 'a2000000-0000-4000-8000-000000000002' and deleted_at is null),
  'default_all', 'default_all stores the subject topics');
select is((select scope_status from public.exams where id = 'a2000000-0000-4000-8000-000000000002'),
  'confirmed', 'the exam scope is confirmed');
select test_helpers.check_err('bob cannot confirm alice exam', 'authenticated', pg_temp.u('bob'),
  $$select public.confirm_exam_scope('a2000000-0000-4000-8000-000000000001', '{}', true)$$);

select test_helpers.check_scalar('logging the grade of P1 says the same grade needed on P2 (weighted mean)', 'authenticated', pg_temp.u('alice'),
  $$(public.log_exam_grade('a2000000-0000-4000-8000-000000000001', 5, 10)->'required'->0->>'needed')::numeric = 6$$, 'true');
select test_helpers.check_scalar('the pending component is reported for its exam', 'authenticated', pg_temp.u('alice'),
  $$(public.log_exam_grade('a2000000-0000-4000-8000-000000000001', 5, 10)->'required'->0->>'exam_id')$$, 'a2000000-0000-4000-8000-000000000002');
select is((select status from public.exams where id = 'a2000000-0000-4000-8000-000000000001'),
  'done', 'a logged exam is marked done with its grade');
select test_helpers.check_err('a grade above the maximum is refused', 'authenticated', pg_temp.u('alice'),
  $$select public.log_exam_grade('a2000000-0000-4000-8000-000000000001', 12, 10)$$);
select test_helpers.check_err('bob cannot log a grade of alice', 'authenticated', pg_temp.u('bob'),
  $$select public.log_exam_grade('a2000000-0000-4000-8000-000000000001', 5, 10)$$);

-- =====================================================================
-- 19. resolve_flag (TRU-02): moderators act inside their Turma, accepting applies the fix
-- =====================================================================
select test_helpers.check_err('bob cannot resolve a flag', 'authenticated', pg_temp.u('bob'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000001', 'accept')$$);
select test_helpers.check_err('dave cannot resolve a flag', 'authenticated', pg_temp.u('dave'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000001', 'reject')$$);
select test_helpers.check_ok('carol accepts a flag and applies the fix', 'authenticated', pg_temp.u('carol'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000001', 'accept', '{"stem":"Quanto e 1+1? (corrigido)"}'::jsonb)$$);
select is((select version from public.questions where id = 'b1000000-0000-4000-8000-000000000001'), 2,
  'the fix bumps the question version');
select is((select count(*)::int from public.item_revisions where item_id = 'b1000000-0000-4000-8000-000000000001' and version = 2),
  1, 'the fix writes an item revision');
select test_helpers.check_rows('bob (member) reads the revision of the question', 'authenticated', pg_temp.u('bob'),
  $$select id from public.item_revisions$$, 1);
select test_helpers.check_err('a resolved flag cannot be resolved again', 'authenticated', pg_temp.u('carol'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000001', 'reject')$$);
select test_helpers.check_ok('carol removes the question (second flag)', 'authenticated', pg_temp.u('carol'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000002', 'remove')$$);
select test_helpers.check_rows('bob cannot see the removed question', 'authenticated', pg_temp.u('bob'),
  $$select id from public.questions where id = 'b1000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('carol (moderator) sees the removed question', 'authenticated', pg_temp.u('carol'),
  $$select id from public.questions where id = 'b1000000-0000-4000-8000-000000000001'$$, 1);
select is((select count(*)::int from private.moderation_actions where action = 'remove' and flag_id = 'b5000000-0000-4000-8000-000000000002'),
  1, 'the removal of a flagged item is logged');
select test_helpers.check_err('a note cannot be removed by a flag (no hidden state)', 'authenticated', pg_temp.u('carol'),
  $$select public.resolve_flag('b5000000-0000-4000-8000-000000000003', 'remove')$$);

select * from finish();
rollback;
