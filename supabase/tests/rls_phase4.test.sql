-- RLS and constraint suite for the Phase 4 tables (data-model.md §5.10 ENEM, §5.8 argument_sessions, §6.2).
-- Personas: alice and bob (students), adm (app admin who imported the bank). Everything runs inside one
-- transaction that is rolled back.

begin;
select no_plan();

create or replace function pg_temp.u(p text) returns uuid
language sql immutable as $$
  select case p
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob'   then '22222222-2222-4222-8222-222222222222'
    when 'adm'   then '99999999-9999-4999-8999-999999999999'
  end::uuid
$$;

-- =====================================================================
-- Seed (superuser, bypasses RLS)
-- =====================================================================
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@studify.test'),
  ('22222222-2222-4222-8222-222222222222', 'bob@studify.test'),
  ('99999999-9999-4999-8999-999999999999', 'adm@studify.test');

insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, app_role) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2008, 3, 'v1', now(), 'user'),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2008, 5, 'v1', now(), 'user'),
  ('99999999-9999-4999-8999-999999999999', 'Adm',   'approved', 1980, 1, 'v1', now(), 'app_admin');

-- The system subject of the ENEM bank (Matemática) and alice's personal subject.
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon, enem_area, system_kind) values
  ('5e000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999', '99999999-9999-4999-8999-999999999999', 'ENEM Matemática', '#3355aa', 'calc', 'MT', 'enem_bank');
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon, enem_area) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Matemática', '#00aa00', 'calc', 'MT');

insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('5e700000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000001', 'unit', 'Banco MT'),
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'unit', 'Funções');

-- Two bank questions: one published item, one waiting for review.
insert into public.questions (id, subject_id, node_id, type, stem, payload, origin, enem_skill_code) values
  ('9e000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000001', '5e700000-0000-4000-8000-000000000001',
   'mcq_single', 'Questão publicada', '{"options":[{"id":"A","text":"1"},{"id":"B","text":"2"},{"id":"C","text":"3"},{"id":"D","text":"4"},{"id":"E","text":"5"}],"correct":"C"}', 'enem_official', 'MT-H21'),
  ('9e000000-0000-4000-8000-000000000002', '5e000000-0000-4000-8000-000000000001', '5e700000-0000-4000-8000-000000000001',
   'mcq_single', 'Questão em revisão', '{"options":[{"id":"A","text":"1"},{"id":"B","text":"2"},{"id":"C","text":"3"},{"id":"D","text":"4"},{"id":"E","text":"5"}],"correct":"A"}', 'enem_official', 'MT-H21');
insert into public.enem_items (id, question_id, edition_year, day, area, co_item, answer_key, skill_code, review_status, explanation_status) values
  ('e1000000-0000-4000-8000-000000000001', '9e000000-0000-4000-8000-000000000001', 2023, 2, 'MT', '12345', 'C', 'MT-H21', 'ok', 'ok'),
  ('e1000000-0000-4000-8000-000000000002', '9e000000-0000-4000-8000-000000000002', 2023, 2, 'MT', '12346', 'A', 'MT-H21', 'needs_review', 'pending');
insert into public.enem_item_params (enem_item_id, a, b, c, source) values
  ('e1000000-0000-4000-8000-000000000001', 1.2, 0.4, 0.18, 'microdata_2023'),
  ('e1000000-0000-4000-8000-000000000002', 0.9, -0.3, 0.2, 'microdata_2023');

insert into public.goals (id, user_id, mode, name, start_date, end_date) values
  ('60000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'enem', 'ENEM 2027', '2026-10-01', '2027-11-14'),
  ('60000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'exam_week', 'Provas', '2026-10-01', '2026-12-01');

insert into public.essay_themes (id, title, source, created_by) values
  ('7e000000-0000-4000-8000-000000000001', 'Desafios da mobilidade urbana no Brasil', 'predicted', null),
  ('7e000000-0000-4000-8000-000000000002', 'Tema pessoal da Alice sobre leitura', 'custom', '11111111-1111-4111-8111-111111111111');

insert into public.atualidades_digests (id, week_start, status, published_at) values
  ('ad000000-0000-4000-8000-000000000001', '2026-10-19', 'published', now()),
  ('ad000000-0000-4000-8000-000000000002', '2026-10-26', 'draft', null);
insert into public.atualidades_items (id, digest_id, title, summary_md, why_md, sources, withdrawn) values
  ('a1000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001', 'Item publicado', 'Resumo', 'Por que importa', '[{"url":"https://agenciabrasil.ebc.com.br/x","name":"Agência Brasil"}]', false),
  ('a1000000-0000-4000-8000-000000000002', 'ad000000-0000-4000-8000-000000000001', 'Item retirado', 'Resumo', 'Por que importa', '[{"url":"https://agenciabrasil.ebc.com.br/y","name":"Agência Brasil"}]', true),
  ('a1000000-0000-4000-8000-000000000003', 'ad000000-0000-4000-8000-000000000002', 'Rascunho', 'Resumo', 'Por que importa', '[{"url":"https://agenciabrasil.ebc.com.br/z","name":"Agência Brasil"}]', false);

insert into public.argument_sessions (id, user_id, goal_mode, theme, theme_source, mode, raw_turns) values
  ('a5000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'enem', 'Uso de celulares nas escolas', 'custom', 'debate', '[{"role":"user","content":"x"}]');

-- =====================================================================
-- 1. Structure and seeds
-- =====================================================================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and c.relname in ('enem_editions','enem_skills','enem_topics','knowledge_node_enem_topics','enem_items',
                                'enem_item_params','enem_topic_stats','enem_topic_trends','enem_redacao_themes',
                                'essay_themes','repertorio_items','sisu_offers','sisu_targets','atualidades_digests',
                                'atualidades_items','argument_sessions')),
  16, 'Phase 4 creates 16 public tables');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
              and c.relname in ('enem_editions','enem_skills','enem_topics','knowledge_node_enem_topics','enem_items',
                                'enem_item_params','enem_topic_stats','enem_topic_trends','enem_redacao_themes',
                                'essay_themes','repertorio_items','sisu_offers','sisu_targets','atualidades_digests',
                                'atualidades_items','argument_sessions')),
  0, 'every Phase 4 table has RLS');
select is((select count(*)::int from public.enem_skills), 120, 'H1-H30 for each of the 4 areas are seeded');
select is((select competency_no::int from public.enem_skills where code = 'MT-H21'), 5, 'MT-H21 belongs to competência 5 (spec 09 §8.2)');
select is((select competency_no::int from public.enem_skills where code = 'LC-H7'), 2, 'LC-H7 belongs to competência 2 (foreign language)');
select is((select competency_no::int from public.enem_skills where code = 'CH-H30'), 6, 'CH-H30 belongs to competência 6');
select is((select count(*)::int from public.enem_redacao_themes where application = 'regular'), 16, 'past redação themes 2009-2024 are seeded');
select test_helpers.check_sqlstate('a skill code outside H1-H30 is rejected',
  $$insert into public.enem_skills (code, area, competency_no, skill_no) values ('MT-H31', 'MT', 7, 31)$$, '23514');
select test_helpers.check_sqlstate('official dates need a verification stamp',
  $$insert into public.enem_editions (year, day1_date, dates_status) values (2027, '2027-11-07', 'official')$$, '23514');
select test_helpers.check_sqlstate('a theme of source custom needs an author',
  $$insert into public.essay_themes (title, source) values ('Tema sem autor qualquer', 'custom')$$, '23514');
select test_helpers.check_sqlstate('an Atualidades item needs at least one source',
  $$insert into public.atualidades_items (digest_id, title, summary_md, why_md, sources)
    values ('ad000000-0000-4000-8000-000000000001', 'Sem fonte', 'x', 'y', '[]')$$, '23514');

-- =====================================================================
-- 2. Bank: only published items, their questions and parameters
-- =====================================================================
select test_helpers.check_rows('a student sees only the published item', 'authenticated', pg_temp.u('alice'),
  $$select id from public.enem_items$$, 1);
select test_helpers.check_rows('a student reads the question of a published item', 'authenticated', pg_temp.u('alice'),
  $$select id from public.questions where id = '9e000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_rows('a student cannot read the question of an item under review', 'authenticated', pg_temp.u('alice'),
  $$select id from public.questions where id = '9e000000-0000-4000-8000-000000000002'$$, 0);
select test_helpers.check_rows('TRI parameters of unpublished items stay hidden', 'authenticated', pg_temp.u('bob'),
  $$select enem_item_id from public.enem_item_params$$, 1);
select test_helpers.check_rows('the admin sees items under review', 'authenticated', pg_temp.u('adm'),
  $$select id from public.enem_items$$, 2);
select test_helpers.check_rows('a student sees the system subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.subjects where system_kind = 'enem_bank'$$, 1);
select test_helpers.check_rows('a student does not see another student''s personal subject', 'authenticated', pg_temp.u('bob'),
  $$select id from public.subjects where id = 'a0000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_err('students cannot write the bank', 'authenticated', pg_temp.u('alice'),
  $$update public.enem_items set answer_key = 'A' where id = 'e1000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('students cannot write the skill list', 'authenticated', pg_temp.u('alice'),
  $$insert into public.enem_skills (code, area, competency_no, skill_no) values ('MT-H30', 'MT', 7, 30)$$);
select test_helpers.check_rows('everyone reads the skills', 'authenticated', pg_temp.u('bob'),
  $$select code from public.enem_skills where area = 'CN'$$, 30);

-- =====================================================================
-- 3. Essay themes: shared, custom only for the author
-- =====================================================================
select test_helpers.check_rows('alice sees the predicted theme and her own', 'authenticated', pg_temp.u('alice'),
  $$select id from public.essay_themes$$, 2);
select test_helpers.check_rows('bob does not see alice''s custom theme', 'authenticated', pg_temp.u('bob'),
  $$select id from public.essay_themes$$, 1);
select test_helpers.check_ok('bob writes a custom theme', 'authenticated', pg_temp.u('bob'),
  $$insert into public.essay_themes (title, source, created_by) values ('O tema do Bob sobre esporte', 'custom', '22222222-2222-4222-8222-222222222222')$$);
select test_helpers.check_err('a student cannot publish a predicted theme', 'authenticated', pg_temp.u('bob'),
  $$insert into public.essay_themes (title, source, created_by) values ('Tema falso previsto pela IA', 'predicted', '22222222-2222-4222-8222-222222222222')$$);

-- =====================================================================
-- 4. Atualidades: published digests and items not withdrawn
-- =====================================================================
select test_helpers.check_rows('students see published digests only', 'authenticated', pg_temp.u('alice'),
  $$select id from public.atualidades_digests$$, 1);
select test_helpers.check_rows('withdrawn and draft items are hidden', 'authenticated', pg_temp.u('alice'),
  $$select id from public.atualidades_items$$, 1);

-- =====================================================================
-- 5. Repertório and Meta SISU: own rows only
-- =====================================================================
select test_helpers.check_ok('alice saves a repertório item', 'authenticated', pg_temp.u('alice'),
  $$insert into public.repertorio_items (user_id, kind, text, atualidades_item_id)
    values ('11111111-1111-4111-8111-111111111111', 'data', 'Dado do IBGE sobre mobilidade', 'a1000000-0000-4000-8000-000000000001')$$);
select test_helpers.check_err('repertório verification is not client-writable', 'authenticated', pg_temp.u('alice'),
  $$insert into public.repertorio_items (user_id, kind, text, verified) values ('11111111-1111-4111-8111-111111111111', 'quote', 'Citação inventada', 'yes')$$);
select test_helpers.check_rows('bob does not see alice''s repertório', 'authenticated', pg_temp.u('bob'),
  $$select id from public.repertorio_items$$, 0);
select test_helpers.check_ok('alice sets a manual SISU target on her ENEM goal', 'authenticated', pg_temp.u('alice'),
  $$insert into public.sisu_targets (user_id, goal_id, manual, cutoff_used)
    values ('11111111-1111-4111-8111-111111111111', '60000000-0000-4000-8000-000000000001', '{"label":"Medicina","weights":{"LC":1,"CH":1,"CN":2,"MT":3,"RED":2}}', 720)$$);
select test_helpers.check_err('a SISU target cannot hang on an exam_week goal', 'authenticated', pg_temp.u('alice'),
  $$insert into public.sisu_targets (user_id, goal_id, manual, cutoff_used)
    values ('11111111-1111-4111-8111-111111111111', '60000000-0000-4000-8000-000000000002', '{"label":"X"}', 700)$$);
select test_helpers.check_err('bob cannot add a target to alice''s goal', 'authenticated', pg_temp.u('bob'),
  $$insert into public.sisu_targets (user_id, goal_id, manual, cutoff_used)
    values ('22222222-2222-4222-8222-222222222222', '60000000-0000-4000-8000-000000000001', '{"label":"X"}', 700)$$);
select test_helpers.check_rows('bob does not see alice''s SISU targets (ENM-06.5)', 'authenticated', pg_temp.u('bob'),
  $$select id from public.sisu_targets$$, 0);
select test_helpers.check_sqlstate('a target needs an offer or manual data',
  $$insert into public.sisu_targets (user_id, goal_id, cutoff_used) values ('11111111-1111-4111-8111-111111111111', '60000000-0000-4000-8000-000000000001', 700)$$, '23514');

-- =====================================================================
-- 6. Argumentação: own sessions, replay hidden, writes through the API
-- =====================================================================
select test_helpers.check_rows('alice reads her session', 'authenticated', pg_temp.u('alice'),
  $$select id, rounds from public.argument_sessions$$, 1);
select test_helpers.check_err('the model replay is not selectable', 'authenticated', pg_temp.u('alice'),
  $$select raw_turns from public.argument_sessions$$);
select test_helpers.check_err('the rubric cannot be written by the client', 'authenticated', pg_temp.u('alice'),
  $$update public.argument_sessions set rubric = '{"total":100}' where user_id = '11111111-1111-4111-8111-111111111111'$$);
select test_helpers.check_rows('bob does not see alice''s session', 'authenticated', pg_temp.u('bob'),
  $$select id from public.argument_sessions$$, 0);

select * from finish();
rollback;
