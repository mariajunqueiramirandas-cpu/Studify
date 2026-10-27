-- RLS, constraint and Realtime suite for the Phase 3 tables (data-model.md §5.7 study_rooms, §5.8 camera_captures,
-- podcast_episodes, podcast_plays, podcast_interactions, teaching_sessions; §6.2; §8.2 room channel).
-- Personas: alice (Turma A member, owns a personal subject), bob (Turma A member), dave (outside Turma A),
-- erin (Turma A owner). Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

create or replace function pg_temp.u(p text) returns uuid
language sql immutable as $$
  select case p
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob'   then '22222222-2222-4222-8222-222222222222'
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
  ('44444444-4444-4444-8444-444444444444', 'dave@studify.test'),
  ('55555555-5555-4555-8555-555555555555', 'erin@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now()),
  ('44444444-4444-4444-8444-444444444444', 'Dave',  'approved', 2009, 2, 'v1', now()),
  ('55555555-5555-4555-8555-555555555555', 'Erin',  'approved', 1985, 1, 'v1', now());

insert into public.class_groups (id, name, owner_id) values
  ('77777777-7777-4777-8777-777777777777', 'Turma A', '55555555-5555-4555-8555-555555555555');
insert into public.class_group_members (class_group_id, user_id, role, status, joined_at) values
  ('77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'owner',  'active', now()),
  ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'member', 'active', now()),
  ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', 'member', 'active', now());

-- Biologia (alice, personal) and Matematica (Turma A, created by erin).
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf');
insert into public.subjects (id, owner_class_group_id, created_by, name, color, icon) values
  ('50000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'Matematica', '#aa0000', 'calc');

insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Celulas'),
  ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'unit', 'Funcoes');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'topic', 'Membrana'),
  ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'topic', 'Funcao afim');

-- Captures: alice's explain capture (with a hidden solver payload) and bob's solve capture.
insert into public.camera_captures (id, user_id, intent, subject_id, image_paths, solver, status) values
  ('ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'solve', 'a0000000-0000-4000-8000-000000000001',
   '{photos/11111111-1111-4111-8111-111111111111/ca000000-0000-4000-8000-000000000001/1.jpg}',
   '{"final_answer":"42"}', 'ready'),
  ('ca000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'explain', null,
   '{photos/22222222-2222-4222-8222-222222222222/ca000000-0000-4000-8000-000000000002/1.jpg}', null, 'queued');

-- Episodes: a shared overview of Matematica, alice's personal exam review of Matematica, and a Biologia episode.
insert into public.podcast_episodes (id, subject_id, node_ids, style, length_minutes, owner_user_id, class_group_id, cache_key, status, created_by) values
  ('e1000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '{40000000-0000-4000-8000-000000000002}',
   'overview', 10, null, '77777777-7777-4777-8777-777777777777', repeat('a', 64), 'ready', '55555555-5555-4555-8555-555555555555'),
  ('e1000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', '{40000000-0000-4000-8000-000000000002}',
   'exam_review', 5, '11111111-1111-4111-8111-111111111111', null, repeat('b', 64), 'ready', '11111111-1111-4111-8111-111111111111'),
  ('e1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000002}',
   'deep', 15, null, null, repeat('c', 64), 'scripting', '11111111-1111-4111-8111-111111111111');

insert into public.podcast_interactions (id, user_id, episode_id, position_ms, segment_id, question_text, input_mode, answer_lines) values
  ('e2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'e1000000-0000-4000-8000-000000000001',
   65000, 's2', 'O que e coeficiente angular?', 'text', '[{"speaker":"bia","text":"E a inclinacao."}]');

insert into public.teaching_sessions (id, user_id, subject_id, node_id, length, plan, evaluation_state, raw_turns, messages) values
  ('e3000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001',
   'a7000000-0000-4000-8000-000000000002', 'short', '{"misconceptions":[{"id":"m1"}]}', '{"m1":"hidden"}', '[]',
   '[{"role":"lucas","text":"E ai!"}]');

-- A room in Turma A hosted by erin, with alice inside.
insert into public.study_rooms (id, class_group_id, host_id, name) values
  ('e4000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'Revisao de Mat');
insert into public.study_room_members (room_id, user_id) values
  ('e4000000-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555'),
  ('e4000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');

-- =====================================================================
-- 1. RLS is enabled on every Phase 3 table
-- =====================================================================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in ('camera_captures','podcast_episodes','podcast_plays','podcast_interactions',
                                'teaching_sessions','study_rooms','study_room_members')),
  7, 'Phase 3 creates 7 public tables');
select ok((select relrowsecurity from pg_class where oid = 'public.camera_captures'::regclass), 'camera_captures has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.podcast_episodes'::regclass), 'podcast_episodes has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.podcast_plays'::regclass), 'podcast_plays has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.podcast_interactions'::regclass), 'podcast_interactions has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.teaching_sessions'::regclass), 'teaching_sessions has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.study_rooms'::regclass), 'study_rooms has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.study_room_members'::regclass), 'study_room_members has RLS');

-- =====================================================================
-- 2. camera_captures (CAM-00.8): own rows, own photos, hidden solver
-- =====================================================================
select test_helpers.check_rows('alice reads her capture', 'authenticated', pg_temp.u('alice'),
  $$select id from public.camera_captures$$, 1);
select test_helpers.check_rows('bob does not see alice''s capture', 'authenticated', pg_temp.u('bob'),
  $$select id from public.camera_captures where user_id = '11111111-1111-4111-8111-111111111111'$$, 0);
select test_helpers.check_err('the hidden solver (final answer) is not selectable', 'authenticated', pg_temp.u('alice'),
  $$select solver from public.camera_captures$$);
select test_helpers.check_ok('alice inserts a capture that points at her own photos', 'authenticated', pg_temp.u('alice'),
  $$insert into public.camera_captures (user_id, intent, image_paths)
    values ('11111111-1111-4111-8111-111111111111', 'explain', '{photos/11111111-1111-4111-8111-111111111111/x/1.jpg}')$$);
select test_helpers.check_err('a capture cannot point at another user''s photos', 'authenticated', pg_temp.u('alice'),
  $$insert into public.camera_captures (user_id, intent, image_paths)
    values ('11111111-1111-4111-8111-111111111111', 'explain', '{photos/22222222-2222-4222-8222-222222222222/x/1.jpg}')$$);
select test_helpers.check_err('a capture cannot be created for someone else', 'authenticated', pg_temp.u('alice'),
  $$insert into public.camera_captures (user_id, intent, image_paths)
    values ('22222222-2222-4222-8222-222222222222', 'explain', '{photos/22222222-2222-4222-8222-222222222222/x/1.jpg}')$$);
select test_helpers.check_err('a capture cannot target a subject the user cannot read', 'authenticated', pg_temp.u('dave'),
  $$insert into public.camera_captures (user_id, intent, subject_id, image_paths)
    values ('44444444-4444-4444-8444-444444444444', 'add_to_subject', 'a0000000-0000-4000-8000-000000000001',
            '{photos/44444444-4444-4444-8444-444444444444/x/1.jpg}')$$);
select test_helpers.check_err('a capture cannot write its own analysis (status)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.camera_captures (user_id, intent, image_paths, status)
    values ('11111111-1111-4111-8111-111111111111', 'explain', '{photos/11111111-1111-4111-8111-111111111111/x/2.jpg}', 'ready')$$);
select test_helpers.check_rows('alice saves her capture', 'authenticated', pg_temp.u('alice'),
  $$update public.camera_captures set saved = true where id = 'ca000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('alice cannot rewrite the transcription herself', 'authenticated', pg_temp.u('alice'),
  $$update public.camera_captures set transcription = 'x' where id = 'ca000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('bob cannot touch alice''s capture', 'authenticated', pg_temp.u('bob'),
  $$update public.camera_captures set saved = true where id = 'ca000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_sqlstate('a capture holds at most 20 photos (CAM-00.4)',
  $$insert into public.camera_captures (user_id, intent, image_paths)
    select '11111111-1111-4111-8111-111111111111', 'add_to_subject', array_agg('photos/11111111-1111-4111-8111-111111111111/y/' || g || '.jpg')
      from generate_series(1, 21) g$$, '23514');
select test_helpers.check_sqlstate('an unknown intent is rejected',
  $$insert into public.camera_captures (user_id, intent, image_paths)
    values ('11111111-1111-4111-8111-111111111111', 'translate', '{photos/11111111-1111-4111-8111-111111111111/z/1.jpg}')$$, '23514');
select test_helpers.check_sqlstate('questions.source_capture_id now references camera_captures',
  $$insert into public.questions (subject_id, node_id, type, stem, payload, origin, source_capture_id)
    values ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'short_answer', 'Q', '{}', 'photo',
            'ca000000-0000-4000-8000-0000000000ff')$$, '23503');
select test_helpers.check_sqlstate('essays.capture_id now references camera_captures',
  $$insert into public.essays (user_id, kind, capture_id)
    values ('11111111-1111-4111-8111-111111111111', 'school_answer', 'ca000000-0000-4000-8000-0000000000ff')$$, '23503');
select test_helpers.check_ok('a tutor thread can be scoped to a capture (CAM-01.4)', 'postgres', null,
  $$insert into public.tutor_threads (user_id, scope_type, capture_id)
    values ('11111111-1111-4111-8111-111111111111', 'capture', 'ca000000-0000-4000-8000-000000000001')$$);

-- =====================================================================
-- 3. podcast_episodes (INT-01.6): shared in the Turma, exam_review personal
-- =====================================================================
select test_helpers.check_rows('bob (Turma member) sees the shared Matematica overview only', 'authenticated', pg_temp.u('bob'),
  $$select id from public.podcast_episodes$$, 1);
select test_helpers.check_rows('alice sees the shared overview, her exam review and her Biologia episode', 'authenticated', pg_temp.u('alice'),
  $$select id from public.podcast_episodes$$, 3);
select test_helpers.check_rows('dave (outsider) sees no episode', 'authenticated', pg_temp.u('dave'),
  $$select id from public.podcast_episodes$$, 0);
select test_helpers.check_err('clients cannot create episodes (podcast-create does)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.podcast_episodes (subject_id, node_ids, style, length_minutes, cache_key, created_by)
    values ('a0000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000002}', 'overview', 5, repeat('d', 64),
            '11111111-1111-4111-8111-111111111111')$$);
select test_helpers.check_sqlstate('an exam_review episode must have an owner',
  $$insert into public.podcast_episodes (subject_id, node_ids, style, length_minutes, cache_key, created_by)
    values ('a0000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000002}', 'exam_review', 5, repeat('e', 64),
            '11111111-1111-4111-8111-111111111111')$$, '23514');
select test_helpers.check_sqlstate('episode lengths are 5, 10 or 15 minutes',
  $$insert into public.podcast_episodes (subject_id, node_ids, style, length_minutes, cache_key, created_by)
    values ('a0000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000002}', 'overview', 20, repeat('f', 64),
            '11111111-1111-4111-8111-111111111111')$$, '23514');
select test_helpers.check_sqlstate('one live episode per cache key (INT-01.6 reuse)',
  $$insert into public.podcast_episodes (subject_id, node_ids, style, length_minutes, cache_key, created_by)
    values ('50000000-0000-4000-8000-000000000001', '{40000000-0000-4000-8000-000000000002}', 'overview', 10, repeat('a', 64),
            '22222222-2222-4222-8222-222222222222')$$, '23505');
select test_helpers.check_ok('a failed episode does not block a retry with the same key', 'postgres', null,
  $$update public.podcast_episodes set status = 'failed' where id = 'e1000000-0000-4000-8000-000000000003';
    insert into public.podcast_episodes (subject_id, node_ids, style, length_minutes, cache_key, created_by)
    values ('a0000000-0000-4000-8000-000000000001', '{a7000000-0000-4000-8000-000000000002}', 'deep', 15, repeat('c', 64),
            '11111111-1111-4111-8111-111111111111')$$);

-- =====================================================================
-- 4. podcast_plays and podcast_interactions
-- =====================================================================
select test_helpers.check_ok('bob records his position in the shared episode', 'authenticated', pg_temp.u('bob'),
  $$insert into public.podcast_plays (user_id, episode_id, position_ms)
    values ('22222222-2222-4222-8222-222222222222', 'e1000000-0000-4000-8000-000000000001', 120000)$$);
select test_helpers.check_err('bob cannot record a play of alice''s personal episode', 'authenticated', pg_temp.u('bob'),
  $$insert into public.podcast_plays (user_id, episode_id, position_ms)
    values ('22222222-2222-4222-8222-222222222222', 'e1000000-0000-4000-8000-000000000002', 1)$$);
select test_helpers.check_err('a play cannot be recorded for another user', 'authenticated', pg_temp.u('bob'),
  $$insert into public.podcast_plays (user_id, episode_id, position_ms)
    values ('11111111-1111-4111-8111-111111111111', 'e1000000-0000-4000-8000-000000000001', 1)$$);
select test_helpers.check_rows('bob updates his own position', 'authenticated', pg_temp.u('bob'),
  $$update public.podcast_plays set position_ms = 130000, downloaded = true
     where user_id = '22222222-2222-4222-8222-222222222222'$$, 1);
select test_helpers.check_rows('alice cannot read bob''s plays', 'authenticated', pg_temp.u('alice'),
  $$select episode_id from public.podcast_plays where user_id = '22222222-2222-4222-8222-222222222222'$$, 0);

select test_helpers.check_rows('alice reads her own question to the hosts', 'authenticated', pg_temp.u('alice'),
  $$select id from public.podcast_interactions$$, 1);
select test_helpers.check_rows('bob does not read alice''s questions (INT-01.9)', 'authenticated', pg_temp.u('bob'),
  $$select id from public.podcast_interactions$$, 0);
select test_helpers.check_err('clients cannot insert interactions (podcast-ask does)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.podcast_interactions (user_id, episode_id, position_ms, segment_id, question_text, input_mode)
    values ('11111111-1111-4111-8111-111111111111', 'e1000000-0000-4000-8000-000000000001', 1, 's1', 'oi', 'text')$$);
select test_helpers.check_sqlstate('interactions are append-only (forbid_mutation)',
  $$update public.podcast_interactions set question_text = 'x' where id = 'e2000000-0000-4000-8000-000000000001'$$, '42501');

-- =====================================================================
-- 5. teaching_sessions (INT-02.3): the plan never reaches the app
-- =====================================================================
select test_helpers.check_rows('alice reads her lesson (public columns)', 'authenticated', pg_temp.u('alice'),
  $$select id, messages, status, score from public.teaching_sessions$$, 1);
select test_helpers.check_err('the hidden plan is not selectable', 'authenticated', pg_temp.u('alice'),
  $$select plan from public.teaching_sessions$$);
select test_helpers.check_err('the evaluation state is not selectable', 'authenticated', pg_temp.u('alice'),
  $$select evaluation_state from public.teaching_sessions$$);
select test_helpers.check_err('the replay turns are not selectable', 'authenticated', pg_temp.u('alice'),
  $$select raw_turns from public.teaching_sessions$$);
select test_helpers.check_rows('bob does not see alice''s lesson', 'authenticated', pg_temp.u('bob'),
  $$select id from public.teaching_sessions$$, 0);
select test_helpers.check_err('clients cannot create lessons (teaching-start does)', 'authenticated', pg_temp.u('alice'),
  $$insert into public.teaching_sessions (user_id, subject_id, node_id, length)
    values ('11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'full')$$);
select test_helpers.check_err('clients cannot write their own score', 'authenticated', pg_temp.u('alice'),
  $$update public.teaching_sessions set score = 100 where id = 'e3000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_rows('alice can delete her lesson (tombstone)', 'authenticated', pg_temp.u('alice'),
  $$update public.teaching_sessions set deleted_at = now() where id = 'e3000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_sqlstate('one active lesson per student and topic',
  $$insert into public.teaching_sessions (user_id, subject_id, node_id, length)
    values ('22222222-2222-4222-8222-222222222222', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'short');
    insert into public.teaching_sessions (user_id, subject_id, node_id, length)
    values ('22222222-2222-4222-8222-222222222222', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'full')$$, '23505');
select test_helpers.check_sqlstate('a finished lesson needs finished_at',
  $$insert into public.teaching_sessions (user_id, subject_id, node_id, length, status)
    values ('22222222-2222-4222-8222-222222222222', '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'short', 'finished')$$, '23514');
select test_helpers.check_sqlstate('a score is between 0 and 100',
  $$update public.teaching_sessions set score = 101 where id = 'e3000000-0000-4000-8000-000000000001'$$, '23514');

-- =====================================================================
-- 6. study_rooms and study_room_members (SOC-05)
-- =====================================================================
select test_helpers.check_rows('a Turma member sees the room', 'authenticated', pg_temp.u('bob'),
  $$select id from public.study_rooms$$, 1);
select test_helpers.check_rows('an outsider does not see the room', 'authenticated', pg_temp.u('dave'),
  $$select id from public.study_rooms$$, 0);
select test_helpers.check_rows('a Turma member sees who is in the room', 'authenticated', pg_temp.u('bob'),
  $$select user_id from public.study_room_members$$, 2);
select test_helpers.check_rows('an outsider does not see the room members', 'authenticated', pg_temp.u('dave'),
  $$select user_id from public.study_room_members$$, 0);
select test_helpers.check_err('clients cannot open rooms directly (room-control does)', 'authenticated', pg_temp.u('bob'),
  $$insert into public.study_rooms (class_group_id, host_id, name)
    values ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', 'Sala do Bob')$$);
select test_helpers.check_err('clients cannot change the shared timer', 'authenticated', pg_temp.u('erin'),
  $$update public.study_rooms set timer_state = '{"phase":"focus"}' where id = 'e4000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_sqlstate('only Turma members can be in a room',
  $$insert into public.study_room_members (room_id, user_id)
    values ('e4000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444')$$, 'P0001');
select test_helpers.check_sqlstate('a closed room needs closed_at',
  $$update public.study_rooms set status = 'closed' where id = 'e4000000-0000-4000-8000-000000000001'$$, '23514');

-- =====================================================================
-- 7. Flags and hides learn the new item types (TRU-02, R19)
-- =====================================================================
select test_helpers.check_ok('bob hides the shared episode for himself', 'authenticated', pg_temp.u('bob'),
  $$insert into public.item_hides (user_id, item_type, item_id, reason)
    values ('22222222-2222-4222-8222-222222222222', 'podcast_episode', 'e1000000-0000-4000-8000-000000000001', 'not_useful')$$);
select test_helpers.check_err('bob cannot hide alice''s personal episode', 'authenticated', pg_temp.u('bob'),
  $$insert into public.item_hides (user_id, item_type, item_id, reason)
    values ('22222222-2222-4222-8222-222222222222', 'podcast_episode', 'e1000000-0000-4000-8000-000000000002', 'wrong')$$);

-- =====================================================================
-- 8. Publication and Realtime (room:{room_id})
-- =====================================================================
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'
            and tablename in ('camera_captures','podcast_episodes')),
  2, 'camera_captures and podcast_episodes are in the supabase_realtime publication');
select test_helpers.check_scalar('two policies still guard realtime.messages', 'authenticated', pg_temp.u('alice'),
  $$select count(*)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages'$$, '2');

insert into realtime.messages (topic, extension, event, payload) values
  ('room:e4000000-0000-4000-8000-000000000001', 'broadcast', 'timer', '{}');
select set_config('realtime.topic', 'room:e4000000-0000-4000-8000-000000000001', true);
select test_helpers.check_rows('a Turma member joins the room channel', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 1);
select test_helpers.check_rows('an outsider cannot join the room channel', 'authenticated', pg_temp.u('dave'),
  $$select id from realtime.messages$$, 0);
select test_helpers.check_ok('alice (in the room) sends presence', 'authenticated', pg_temp.u('alice'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('room:e4000000-0000-4000-8000-000000000001', 'presence', 'presence_diff', '{}')$$);
select test_helpers.check_err('bob (not in the room) cannot send presence', 'authenticated', pg_temp.u('bob'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('room:e4000000-0000-4000-8000-000000000001', 'presence', 'presence_diff', '{}')$$);
select test_helpers.check_err('room members cannot broadcast (reactions go through room-control)', 'authenticated', pg_temp.u('alice'),
  $$insert into realtime.messages (topic, extension, event, payload) values
    ('room:e4000000-0000-4000-8000-000000000001', 'broadcast', 'reaction', '{}')$$);

select set_config('realtime.topic', 'turma:77777777-7777-4777-8777-777777777777', true);
select test_helpers.check_rows('the Turma channel keeps its rule after the policy rewrite (room message + presence)', 'authenticated', pg_temp.u('bob'),
  $$select id from realtime.messages$$, 2);
select test_helpers.check_rows('an outsider still cannot read the Turma channel', 'authenticated', pg_temp.u('dave'),
  $$select id from realtime.messages$$, 0);

select * from finish();
rollback;
