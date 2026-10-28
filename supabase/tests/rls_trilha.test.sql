-- RLS and constraint suite for the Trilha (spec 14, data-model.md trails / trail_steps).
-- Personas: alice (owns the trail) and bob. Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@studify.test'),
  ('22222222-2222-4222-8222-222222222222', 'bob@studify.test');
insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now());
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Biologia', '#00aa00', 'leaf');
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Celulas');
insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title) values
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'topic', 'Membrana');

insert into public.trails (id, user_id, subject_id, plan, outline_hash) values
  ('b1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001',
   '[{"topicId":"a7000000-0000-4000-8000-000000000002","why":null,"conceptIds":["a7000000-0000-4000-8000-000000000002"]}]', 'h');
insert into public.trail_steps (id, trail_id, user_id, chapter_index, topic_id, concept_id, purpose, created_seq, content, prompt_version) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 0,
   'a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'lesson', 1, '{"title":"Membrana"}', 'trail.lesson@v1');

select test_helpers.check_rows('alice reads her trail', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$select id from public.trails$$, 1);
select test_helpers.check_rows('alice reads her trail steps', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$select id from public.trail_steps$$, 1);
select test_helpers.check_rows('bob reads no trail of alice', 'authenticated', '22222222-2222-4222-8222-222222222222',
  $$select id from public.trails$$, 0);
select test_helpers.check_rows('bob reads no trail step of alice', 'authenticated', '22222222-2222-4222-8222-222222222222',
  $$select id from public.trail_steps$$, 0);
select test_helpers.check_err('clients cannot move the trail forward', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$update public.trails set chapter_index = 5$$);
select test_helpers.check_err('clients cannot answer steps directly', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$update public.trail_steps set correct = true$$);
select test_helpers.check_err('clients cannot create steps', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$insert into public.trail_steps (trail_id, user_id, chapter_index, topic_id, concept_id, purpose, created_seq, content, prompt_version) values ('b1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 0, 'a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'lesson', 2, '{}', 'x')$$);
select test_helpers.check_err('anon cannot read trails', 'anon', null,
  $$select id from public.trails$$);
select test_helpers.check_sqlstate('one trail per student and subject',
  $$insert into public.trails (user_id, subject_id, plan, outline_hash) values ('11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', '[]', 'h')$$, '23505');
select test_helpers.check_sqlstate('step purposes are closed',
  $$insert into public.trail_steps (trail_id, user_id, chapter_index, topic_id, concept_id, purpose, created_seq, content, prompt_version) values ('b1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 0, 'a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'video', 3, '{}', 'x')$$, '23514');
select test_helpers.check_sqlstate('trail answers are mastery evidence',
  $$insert into public.mastery_evidence (user_id, node_id, subject_id, source, outcome, weight, ref_type, ref_id, occurred_at) values ('11111111-1111-4111-8111-111111111111', 'a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'trail', 1, 1, 'trail_step', 'b2000000-0000-4000-8000-000000000001', now())$$, null);
select test_helpers.check_sqlstate('the Caderno holds Trilha answers in a trail quiz',
  $$insert into public.quizzes (owner_id, subject_id, kind) values ('11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000001', 'trail')$$, null);
select test_helpers.check_sqlstate('Trilha steps can be re-explained (LRN-03)',
  $$insert into public.explanations (subject_id, target_type, target_id, style, language, body, prompt_version) values ('a0000000-0000-4000-8000-000000000001', 'trail_step', 'b2000000-0000-4000-8000-000000000001', 'simpler', 'pt-BR', 'x', 'explain.restyle@v1')$$, null);

select * from finish();
rollback;
