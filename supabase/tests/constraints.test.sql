-- Schema constraints and foundation behaviour (data-model.md §1, §4): enum CHECKs, shape checks,
-- UUID v7 defaults, unaccent full-text wrapper, try_uuid. Rolled back at the end.

begin;
select no_plan();

-- ---- UUID v7 ---------------------------------------------------------
select ok(substr(public.uuid_v7()::text, 15, 1) = '7', 'uuid_v7() sets the version nibble to 7');
select ok(substr(public.uuid_v7()::text, 20, 1) in ('8','9','a','b'), 'uuid_v7() sets the RFC 4122 variant');
select ok(public.uuid_v7() <> public.uuid_v7(), 'uuid_v7() values are distinct');
create temp table t_ids (a uuid);
insert into t_ids select public.uuid_v7();
select pg_sleep(0.01);
select ok((select a from t_ids) < public.uuid_v7(), 'uuid_v7() ids sort by creation time');

-- ---- seed: profiles, a subject, a node, a document (superuser) -------
insert into auth.users (id, email) values
  ('90000000-0000-4000-8000-000000000001', 'k1@studify.test'),
  ('90000000-0000-4000-8000-000000000002', 'k2@studify.test');
insert into public.profiles (id, display_name, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('90000000-0000-4000-8000-000000000001', 'Kai', 2010, 4, 'v1', now()),
  ('90000000-0000-4000-8000-000000000002', 'Lia', 2008, 6, 'v1', now());
insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Ciencias', '#123456', 'flask');
insert into public.knowledge_nodes (id, subject_id, kind, title) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'unit', 'Unidade');
insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values
  ('93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Apostila', 'notes', 'p', 1, repeat('f', 64));

-- Default id (no id supplied): must be a UUID v7.
insert into public.subjects (owner_profile_id, created_by, name, color, icon) values
  ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'Historia', '#654321', 'book');
select ok((select substr(id::text, 15, 1) from public.subjects where name = 'Historia') = '7',
  'the default id of a new subject is a UUID v7');

insert into public.invites (code, created_by) values ('ABCD2345', '90000000-0000-4000-8000-000000000001');
select ok((select expires_at - created_at from public.invites where code = 'ABCD2345') = interval '7 days',
  'an invite expires after 7 days by default');

-- ---- enum and shape CHECKs (text + CHECK, not Postgres enums) --------
select test_helpers.check_sqlstate('invite codes exclude L (security-privacy.md §9 alphabet)',
  $$insert into public.invites (code, created_by) values ('ABCDL234', '90000000-0000-4000-8000-000000000001')$$, '23514');
select test_helpers.check_sqlstate('invite codes exclude 0',
  $$insert into public.invites (code, created_by) values ('ABCD0234', '90000000-0000-4000-8000-000000000001')$$, '23514');
select test_helpers.check_sqlstate('knowledge node kind is limited to unit, topic, concept',
  $$insert into public.knowledge_nodes (subject_id, kind, title) values ('91000000-0000-4000-8000-000000000001', 'chapter', 'x')$$, '23514');
select test_helpers.check_sqlstate('only units may be roots (topics need a parent)',
  $$insert into public.knowledge_nodes (subject_id, kind, title) values ('91000000-0000-4000-8000-000000000001', 'topic', 'orphan topic')$$, '23514');
select test_helpers.check_sqlstate('review rating is 1..4',
  $$insert into public.review_logs (id, user_id, card_id, rating, reviewed_at, client_reviewed_at) values (gen_random_uuid(), '90000000-0000-4000-8000-000000000001', gen_random_uuid(), 5, now(), now())$$, '23514');
select test_helpers.check_sqlstate('birth month is 1..12',
  $$update public.profiles set birth_month = 13 where id = '90000000-0000-4000-8000-000000000001'$$, '23514');
select test_helpers.check_sqlstate('a subject has exactly one owner',
  $$insert into public.subjects (owner_profile_id, owner_class_group_id, created_by, name, color, icon) values ('90000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777', '90000000-0000-4000-8000-000000000001', 'Dupla', '#123456', 'x')$$, '23514');
select test_helpers.check_sqlstate('checksums are 64 lowercase hex characters',
  $$insert into public.documents (subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256) values ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 't', 'notes', 'p', 1, 'ABC')$$, '23514');
select test_helpers.check_sqlstate('question payload must be a JSON object',
  $$insert into public.questions (subject_id, node_id, type, stem, payload, origin) values ('91000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'mcq_single', 's', '[]', 'generated')$$, '23514');
select test_helpers.check_sqlstate('card origin is limited to the documented values',
  $$insert into public.cards (subject_id, node_id, type, front, back, origin) values ('91000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'basic', 'f', 'b', 'stolen')$$, '23514');
select test_helpers.check_sqlstate('a node cannot be its own prerequisite',
  $$insert into public.node_prerequisites (node_id, prerequisite_node_id, origin) values ('92000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'ai')$$, '23514');
select test_helpers.check_sqlstate('weekly minutes have seven entries',
  $$insert into public.study_preferences (user_id, minutes_by_weekday) values ('90000000-0000-4000-8000-000000000001', '{60,60}')$$, '23514');
select test_helpers.check_sqlstate('a profile needs an auth user (FK)',
  $$insert into public.profiles (id, display_name, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values ('90000000-0000-4000-8000-000000000003', 'Xy', 2008, 1, 'v1', now())$$, '23503');
select test_helpers.check_sqlstate('a minor (born 2010) needs an 8 hour quiet window (PLT-05.3)',
  $$insert into public.study_preferences (user_id, quiet_start, quiet_end) values ('90000000-0000-4000-8000-000000000001', '22:00', '23:00')$$, '23514');

-- ---- one owner per Turma (partial unique index) ----------------------
insert into public.class_groups (id, name, owner_id) values
  ('94000000-0000-4000-8000-000000000001', 'Turma K', '90000000-0000-4000-8000-000000000001');
insert into public.class_group_members (class_group_id, user_id, role, status) values
  ('94000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'owner', 'active');
select test_helpers.check_sqlstate('a Turma has at most one active owner',
  $$insert into public.class_group_members (class_group_id, user_id, role, status) values ('94000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'owner', 'active')$$, '23505');

-- ---- unaccent full-text wrapper (data-model §4 document_pages.tsv) ---
insert into public.document_pages (document_id, page_number, text)
values ('93000000-0000-4000-8000-000000000001', 1, 'Função afim e função quadrática');
select ok(
  (select tsv @@ to_tsquery('portuguese', 'funcao') from public.document_pages where page_number = 1),
  'full text search ignores accents (unaccent wrapper in the generated tsvector)');
select ok(private.f_unaccent('Função') = 'Funcao', 'the immutable unaccent wrapper removes diacritics');

-- ---- try_uuid (storage policy helper) ---------------------------------
select ok(private.try_uuid('not-a-uuid') is null, 'try_uuid returns NULL for non-uuid path segments');
select ok(private.try_uuid('91000000-0000-4000-8000-000000000001') = '91000000-0000-4000-8000-000000000001'::uuid,
  'try_uuid parses uuid path segments');

select * from finish();
rollback;
