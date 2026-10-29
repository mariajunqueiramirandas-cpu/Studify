-- RLS and constraint suite for the notification inbox (data-model.md §5.1 notification_inbox, R34).
-- Personas: alice and bob. Everything runs inside one transaction that is rolled back.

begin;
select no_plan();

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@studify.test'),
  ('22222222-2222-4222-8222-222222222222', 'bob@studify.test');
insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values
  ('11111111-1111-4111-8111-111111111111', 'Alice', 'approved', 2010, 3, 'v1', now()),
  ('22222222-2222-4222-8222-222222222222', 'Bob',   'approved', 2009, 5, 'v1', now());

insert into public.notification_inbox (id, user_id, key, type, channel, title, body, deep_link, rich) values
  ('a1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'doc:1', 'material_ready', 'processing',
   'Material pronto', 'Seu material de Biologia está pronto 📚', 'studify://subjects/1', '{"v":1,"key":"doc:1","template":"basic"}'),
  ('a1000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'duel:9', 'duel_challenge', 'class',
   'Novo duelo', 'Ana te desafiou', null, '{"v":1,"key":"duel:9","template":"basic"}');

select test_helpers.check_rows('alice sees only her inbox', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$select id from public.notification_inbox$$, 1);
select test_helpers.check_rows('alice marks her notification read', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$update public.notification_inbox set read_at = now() where read_at is null$$, 1);
select test_helpers.check_rows('alice cannot mark bob''s notification read', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$update public.notification_inbox set read_at = now() where id = 'a1000000-0000-4000-8000-000000000002'$$, 0);
select test_helpers.check_err('alice cannot rewrite the text', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$update public.notification_inbox set title = 'x' where id = 'a1000000-0000-4000-8000-000000000001'$$);
select test_helpers.check_err('clients cannot insert inbox rows', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$insert into public.notification_inbox (user_id, key, type, channel, title, body, rich) values ('11111111-1111-4111-8111-111111111111', 'k', 't', 'plan', 'T', 'B', '{}')$$);
select test_helpers.check_rows('bob cannot delete alice''s notification', 'authenticated', '22222222-2222-4222-8222-222222222222',
  $$delete from public.notification_inbox where id = 'a1000000-0000-4000-8000-000000000001'$$, 0);
select test_helpers.check_rows('alice clears her own notification', 'authenticated', '11111111-1111-4111-8111-111111111111',
  $$delete from public.notification_inbox where id = 'a1000000-0000-4000-8000-000000000001'$$, 1);
select test_helpers.check_err('anon cannot read the inbox', 'anon', null,
  $$select id from public.notification_inbox$$);
select test_helpers.check_sqlstate('one row per key and user',
  $$insert into public.notification_inbox (user_id, key, type, channel, title, body, rich) values ('22222222-2222-4222-8222-222222222222', 'duel:9', 't', 'class', 'T', 'B', '{}')$$, '23505');
select test_helpers.check_sqlstate('deep links stay inside the app',
  $$insert into public.notification_inbox (user_id, key, type, channel, title, body, deep_link, rich) values ('22222222-2222-4222-8222-222222222222', 'k2', 't', 'class', 'T', 'B', 'https://evil.example', '{}')$$, '23514');
select test_helpers.check_sqlstate('the live channel is not stored',
  $$insert into public.notification_inbox (user_id, key, type, channel, title, body, rich) values ('22222222-2222-4222-8222-222222222222', 'k3', 't', 'live', 'T', 'B', '{}')$$, '23514');

select * from finish();
rollback;
