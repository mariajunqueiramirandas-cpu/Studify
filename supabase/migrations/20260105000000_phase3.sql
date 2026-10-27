-- Phase 3 tables: Câmera Mágica, Podcast Interativo, Ensine o Lucas and Salas de estudo.
-- Source: data-model.md §5.8 (camera_captures, podcast_*, teaching_sessions), §5.7 (study_rooms), §6.2 (matrix),
-- §7 (buckets, already created in 20260101000200_storage.sql), §8 (Realtime); specs 11, 12, 10 (SOC-05).
-- Conventions as in the earlier migrations: text + CHECK enums, UUID v7 ids, deleted_at tombstones on [sync]
-- tables, RLS on every table, writes the client must not forge go through the API (service role).
--
-- Access decisions beyond the matrix (data-model §6.2), all stricter:
--   * camera_captures.solver: the hint ladder with the final answer (CAM-02.4) is never selectable by the
--     client (column grant), so the answer only leaves the server when the student asks for it.
--   * teaching_sessions.plan, evaluation_state and raw_turns: never selectable (INT-02.3, spec 12 §7.3).
--     Every write goes through teaching-start / teaching-turn / teaching-finish, so the score cannot be forged.
--   * study_rooms and study_room_members: read by the Turma; every write goes through room-control, which stamps
--     the shared timer with server time (SOC-05.3).
--   * study_room_members is not in data-model §5.7; it records who was in a room and when, for the group goal
--     (SOC-05.4) and the 20-member cap (SOC-05.6). Presence itself stays on the Realtime channel.

-- =====================================================================
-- 5.8 Câmera Mágica (CAM-01…03)
-- =====================================================================
create table public.camera_captures (
  id                 uuid primary key default public.uuid_v7(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  intent             text not null check (intent in ('explain','solve','add_to_subject','grade_answer','grade_essay')),
  subject_id         uuid references public.subjects(id) on delete set null,
  node_id            uuid references public.knowledge_nodes(id) on delete set null,
  image_paths        text[] not null check (cardinality(image_paths) between 1 and 20),       -- CAM-00.4
  quality_flags      jsonb not null default '{}'::jsonb check (jsonb_typeof(quality_flags) = 'object'),
  faces_blurred      boolean not null default false,                                          -- CAM-00.6
  content_type       text check (content_type in ('book_page','whiteboard','handwritten_notes','exercise','essay','other')),
  language           text,
  transcription      text,
  confirmed_text     text,                                                                    -- CAM-03.4
  edited_ratio       real check (edited_ratio between 0 and 1),                               -- CAM-03.5
  detected_questions jsonb check (detected_questions is null or jsonb_typeof(detected_questions) = 'array'),
  match              jsonb check (match is null or jsonb_typeof(match) = 'object'),           -- {subject_id, node_ids, confidence}
  result             jsonb check (result is null or jsonb_typeof(result) = 'object'),         -- what the student has seen
  solver             jsonb check (solver is null or jsonb_typeof(solver) = 'object'),         -- server only (hint ladder + answer)
  status             text not null default 'queued' check (status in ('queued','processing','ready','failed')),
  error_code         text,
  saved              boolean not null default false,
  expires_at         timestamptz not null default now() + interval '30 days',                -- spec 11 §8.4 (D-38)
  document_id        uuid references public.documents(id) on delete set null,
  question_id        uuid references public.questions(id) on delete set null,
  essay_id           uuid references public.essays(id) on delete set null,
  tutor_thread_id    uuid references public.tutor_threads(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index camera_captures_user on public.camera_captures (user_id, created_at desc) where deleted_at is null;
create index camera_captures_expiry on public.camera_captures (expires_at) where not saved and deleted_at is null;

-- The forward references of the earlier migrations now get their foreign keys.
alter table public.questions
  add constraint questions_source_capture_id_fkey foreign key (source_capture_id)
  references public.camera_captures(id) on delete set null;
alter table public.essays
  add constraint essays_capture_id_fkey foreign key (capture_id)
  references public.camera_captures(id) on delete set null;
alter table public.tutor_threads
  add constraint tutor_threads_capture_id_fkey foreign key (capture_id)
  references public.camera_captures(id) on delete cascade;

-- =====================================================================
-- 5.8 Podcast Interativo (INT-01)
-- =====================================================================
create table public.podcast_episodes (
  id                    uuid primary key default public.uuid_v7(),
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  node_ids              uuid[] not null check (cardinality(node_ids) between 1 and 40),
  style                 text not null check (style in ('overview','deep','exam_review')),
  length_minutes        int not null check (length_minutes in (5, 10, 15)),                 -- data-model §5.8
  owner_user_id         uuid references public.profiles(id) on delete cascade,              -- personal exam_review episodes
  class_group_id        uuid references public.class_groups(id) on delete cascade,          -- shared episodes
  exam_id               uuid references public.exams(id) on delete set null,                -- "Ouvir revisão desta prova"
  cache_key             text not null check (char_length(cache_key) between 16 and 128),
  title                 text check (char_length(title) <= 160),
  script                jsonb check (script is null or jsonb_typeof(script) = 'object'),
  script_version        int not null default 1 check (script_version >= 1),
  source_notes_versions jsonb not null default '{}'::jsonb check (jsonb_typeof(source_notes_versions) = 'object'),
  audio_path            text,                                                                -- null: played with on-device TTS
  duration_ms           int check (duration_ms >= 0),
  chapters              jsonb check (chapters is null or jsonb_typeof(chapters) = 'array'),
  line_timings          jsonb check (line_timings is null or jsonb_typeof(line_timings) = 'array'),
  voices                jsonb check (voices is null or jsonb_typeof(voices) = 'object'),
  status                text not null default 'queued' check (status in ('queued','scripting','synthesizing','ready','failed')),
  error_code            text,
  superseded_by         uuid references public.podcast_episodes(id) on delete set null,
  created_by            uuid not null references public.profiles(id) on delete cascade,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Revisão pra prova uses the student's mastery: always personal (INT-01.6).
  check (style <> 'exam_review' or owner_user_id is not null)
);
create unique index podcast_episodes_cache_key on public.podcast_episodes (cache_key) where status <> 'failed';
create index podcast_episodes_subject on public.podcast_episodes (subject_id, created_at desc);

create table public.podcast_plays (                              -- [sync] resume position and downloads
  user_id      uuid not null references public.profiles(id) on delete cascade,
  episode_id   uuid not null references public.podcast_episodes(id) on delete cascade,
  position_ms  int not null default 0 check (position_ms >= 0),
  completed_at timestamptz,
  downloaded   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, episode_id)
);
create index podcast_plays_sync on public.podcast_plays (updated_at, user_id);

create table public.podcast_interactions (                       -- INT-01.8–9 (written by podcast-ask)
  id                uuid primary key default public.uuid_v7(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  episode_id        uuid not null references public.podcast_episodes(id) on delete cascade,
  position_ms       int not null check (position_ms >= 0),
  segment_id        text not null check (char_length(segment_id) between 1 and 40),
  question_text     text not null check (char_length(question_text) between 1 and 500),
  input_mode        text not null check (input_mode in ('voice','text')),
  answer_lines      jsonb not null default '[]'::jsonb check (jsonb_typeof(answer_lines) = 'array'),
  citations         jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  out_of_material   boolean not null default false,                                           -- INT-01.10
  answer_audio_path text,
  tts_fallback      boolean not null default false,                                           -- INT-01.11
  created_at        timestamptz not null default now()
);
create index podcast_interactions_user_episode on public.podcast_interactions (user_id, episode_id, created_at);

-- =====================================================================
-- 5.8 Ensine o Lucas (INT-02)
-- =====================================================================
create table public.teaching_sessions (
  id               uuid primary key default public.uuid_v7(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  node_id          uuid not null references public.knowledge_nodes(id) on delete cascade,
  length           text not null check (length in ('short','full')),
  plan             jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object'),       -- hidden (INT-02.3)
  messages         jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),     -- [{role, text, at}]
  raw_turns        jsonb not null default '[]'::jsonb check (jsonb_typeof(raw_turns) = 'array'),    -- exact replay (ai-pipeline §6.6)
  evaluation_state jsonb not null default '{}'::jsonb check (jsonb_typeof(evaluation_state) = 'object'),
  turn_count       int not null default 0 check (turn_count >= 0),
  score            int check (score between 0 and 100),
  rubric           jsonb check (rubric is null or jsonb_typeof(rubric) = 'object'),
  gaps             jsonb check (gaps is null or jsonb_typeof(gaps) = 'array'),
  errors_taught    jsonb check (errors_taught is null or jsonb_typeof(errors_taught) = 'array'),
  teach_back       text,
  status           text not null default 'active' check (status in ('active','finished','abandoned')),
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check (status <> 'finished' or finished_at is not null)
);
create index teaching_sessions_user on public.teaching_sessions (user_id, created_at desc) where deleted_at is null;
-- One active lesson per student and topic: a second "Ensine o Lucas" resumes the open one.
create unique index teaching_sessions_one_active on public.teaching_sessions (user_id, node_id)
  where status = 'active' and deleted_at is null;

-- =====================================================================
-- 5.7 Salas de estudo (SOC-05)
-- =====================================================================
create table public.study_rooms (
  id             uuid primary key default public.uuid_v7(),
  class_group_id uuid not null references public.class_groups(id) on delete cascade,
  host_id        uuid not null references public.profiles(id) on delete cascade,
  name           text not null check (char_length(name) between 2 and 40),
  timer_config   jsonb not null default '{"focus_min":25,"break_min":5}'::jsonb check (jsonb_typeof(timer_config) = 'object'),
  timer_state    jsonb not null default '{"phase":"idle","cycle":0}'::jsonb check (jsonb_typeof(timer_state) = 'object'),
  group_goal     jsonb check (group_goal is null or jsonb_typeof(group_goal) = 'object'),   -- {kind, target}
  status         text not null default 'open' check (status in ('open','closed')),
  last_active_at timestamptz not null default now(),                                    -- SOC-05.6: closes after 10 min empty
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (status <> 'closed' or closed_at is not null)
);
create index study_rooms_class_open on public.study_rooms (class_group_id, created_at desc) where status = 'open';

create table public.study_room_members (
  room_id          uuid not null references public.study_rooms(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  status_mode      text not null default 'auto' check (status_mode in ('auto','hidden')),   -- SOC-05.2
  last_reaction_at timestamptz,                                                           -- SOC-05.5 rate limit
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- Room members must be active members of the room's Turma, and blocked pairs never share a room (SOC-X.3).
create or replace function private.study_room_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.study_rooms r
                   join public.class_group_members m on m.class_group_id = r.class_group_id
                  where r.id = new.room_id and m.user_id = new.user_id and m.status = 'active') then
    raise exception 'only members of the Turma can join a study room' using errcode = 'P0001', hint = 'not_member';
  end if;
  return new;
end $$;

create trigger study_room_members_guard_insert before insert on public.study_room_members
  for each row execute function private.study_room_members_guard();

-- =====================================================================
-- Helpers (security definer, stable, search_path = '')
-- =====================================================================
create or replace function private.can_read_episode(p_episode uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.podcast_episodes e
                 where e.id = p_episode and private.can_read_subject(e.subject_id)
                   and (e.owner_user_id is null or e.owner_user_id = auth.uid()));
$$;

create or replace function private.can_see_room(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.study_rooms r where r.id = p_room and private.is_member(r.class_group_id));
$$;

create or replace function private.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.study_room_members rm
                   join public.study_rooms r on r.id = rm.room_id
                  where rm.room_id = p_room and rm.user_id = auth.uid() and rm.left_at is null
                    and r.status = 'open' and private.is_member(r.class_group_id));
$$;

-- TRU-02 (R19): podcast episodes and feed items can be flagged and hidden, so item_scope learns them.
create or replace function private.item_scope(p_type text, p_id uuid)
returns table (subj uuid, personal uuid)
language sql stable security definer set search_path = '' as $$
  select n.subject_id, null::uuid from public.knowledge_nodes n where p_type = 'knowledge_node' and n.id = p_id
  union all
  select c.subject_id, c.personal_for_user_id from public.cards c where p_type = 'card' and c.id = p_id
  union all
  select q.subject_id, q.personal_for_user_id from public.questions q where p_type = 'question' and q.id = p_id
  union all
  select g.subject_id, null::uuid from public.glossary_terms g where p_type = 'glossary_term' and g.id = p_id
  union all
  select nt.subject_id, null::uuid from public.notes nt where p_type = 'note' and nt.id = p_id
  union all
  select e.subject_id, e.personal_for_user_id from public.explanations e where p_type = 'explanation' and e.id = p_id
  union all
  select d.subject_id, null::uuid from public.documents d where p_type = 'document' and d.id = p_id
  union all
  select null::uuid, th.user_id from public.tutor_messages m
    join public.tutor_threads th on th.id = m.thread_id
   where p_type = 'tutor_message' and m.id = p_id
  union all
  select f.subject_id, f.personal_for_user_id from public.feed_items f where p_type = 'feed_item' and f.id = p_id
  union all
  select pe.subject_id, pe.owner_user_id from public.podcast_episodes pe where p_type = 'podcast_episode' and pe.id = p_id
$$;

-- updated_at maintenance (data-model §1.1).
do $$
declare
  t text;
begin
  foreach t in array array[
    'camera_captures','podcast_episodes','podcast_plays','teaching_sessions','study_rooms','study_room_members'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

create trigger podcast_interactions_append_only before update or delete on public.podcast_interactions
  for each row execute function private.forbid_mutation();

-- Realtime (data-model §8.1): async capture analysis and podcast audio the app shows live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.camera_captures, public.podcast_episodes;
  end if;
end $$;

-- =====================================================================
-- Row Level Security and grants (data-model §6.2)
-- =====================================================================

-- ---- camera_captures (own; the analysis is written by capture-analyze / capture-act) ----
alter table public.camera_captures enable row level security;
revoke all on public.camera_captures from anon, authenticated;
grant select (id, user_id, intent, subject_id, node_id, image_paths, quality_flags, faces_blurred, content_type,
              language, transcription, confirmed_text, edited_ratio, detected_questions, match, result, status,
              error_code, saved, expires_at, document_id, question_id, essay_id, tutor_thread_id, created_at,
              updated_at, deleted_at)
  on public.camera_captures to authenticated;
grant insert (id, user_id, intent, subject_id, node_id, image_paths, quality_flags, faces_blurred)
  on public.camera_captures to authenticated;
grant update (saved, deleted_at) on public.camera_captures to authenticated;
create policy camera_captures_select_own on public.camera_captures for select to authenticated
  using (user_id = auth.uid());
-- Stored paths carry the bucket (`photos/{user_id}/{capture_id}/{n}.jpg`, storage policy storage_photos_owner);
-- a capture only points at the owner's photos.
create policy camera_captures_insert_own on public.camera_captures for insert to authenticated
  with check (user_id = auth.uid()
              and (subject_id is null or private.can_read_subject(subject_id))
              and (node_id is null or private.can_read_node(node_id))
              and not exists (select 1 from unnest(image_paths) p where p not like 'photos/' || auth.uid()::text || '/%'));
create policy camera_captures_update_own on public.camera_captures for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- podcast_episodes (subject readers; personal episodes only for their owner) ----
alter table public.podcast_episodes enable row level security;
revoke all on public.podcast_episodes from anon, authenticated;
grant select on public.podcast_episodes to authenticated;
create policy podcast_episodes_select on public.podcast_episodes for select to authenticated
  using (private.can_read_subject(subject_id) and (owner_user_id is null or owner_user_id = auth.uid()));

-- ---- podcast_plays (own, any episode the user can read) ----
alter table public.podcast_plays enable row level security;
revoke all on public.podcast_plays from anon, authenticated;
grant select on public.podcast_plays to authenticated;
grant insert (user_id, episode_id, position_ms, completed_at, downloaded) on public.podcast_plays to authenticated;
grant update (position_ms, completed_at, downloaded, deleted_at) on public.podcast_plays to authenticated;
create policy podcast_plays_select_own on public.podcast_plays for select to authenticated
  using (user_id = auth.uid());
create policy podcast_plays_insert_own on public.podcast_plays for insert to authenticated
  with check (user_id = auth.uid() and private.can_read_episode(episode_id));
create policy podcast_plays_update_own on public.podcast_plays for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.can_read_episode(episode_id));

-- ---- podcast_interactions (own; podcast-ask writes both the question and the answer) ----
alter table public.podcast_interactions enable row level security;
revoke all on public.podcast_interactions from anon, authenticated;
grant select on public.podcast_interactions to authenticated;
create policy podcast_interactions_select_own on public.podcast_interactions for select to authenticated
  using (user_id = auth.uid());

-- ---- teaching_sessions (own; the hidden plan, evaluation and replay are never selectable) ----
alter table public.teaching_sessions enable row level security;
revoke all on public.teaching_sessions from anon, authenticated;
grant select (id, user_id, subject_id, node_id, length, messages, turn_count, score, rubric, gaps, errors_taught,
              teach_back, status, finished_at, created_at, updated_at, deleted_at)
  on public.teaching_sessions to authenticated;
grant update (deleted_at) on public.teaching_sessions to authenticated;
create policy teaching_sessions_select_own on public.teaching_sessions for select to authenticated
  using (user_id = auth.uid());
create policy teaching_sessions_update_own on public.teaching_sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- study_rooms and members (Turma members read; room-control writes) ----
alter table public.study_rooms enable row level security;
revoke all on public.study_rooms from anon, authenticated;
grant select on public.study_rooms to authenticated;
create policy study_rooms_select_member on public.study_rooms for select to authenticated
  using (private.is_member(class_group_id));

alter table public.study_room_members enable row level security;
revoke all on public.study_room_members from anon, authenticated;
grant select on public.study_room_members to authenticated;
create policy study_room_members_select on public.study_room_members for select to authenticated
  using (private.can_see_room(room_id));

revoke all on function private.can_read_episode(uuid), private.can_see_room(uuid), private.is_room_member(uuid)
  from public, anon;
grant execute on function private.can_read_episode(uuid), private.can_see_room(uuid), private.is_room_member(uuid)
  to authenticated, service_role;

-- =====================================================================
-- Realtime authorization: the Phase 2 channel policies learn room:{room_id} (data-model §8.2, api §8.2).
--   room:{room_id}   read: active members of the room's Turma; presence: members currently in the open room.
-- The policies are replaced whole, so every topic of the Phase 2 list keeps its rule.
-- =====================================================================
do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages or realtime.topic() is missing; channel policies were not changed';
    return;
  end if;

  execute 'drop policy if exists realtime_private_read on realtime.messages';
  execute 'drop policy if exists realtime_presence_send on realtime.messages';

  execute $p$
    create policy realtime_private_read on realtime.messages for select to authenticated
    using (
      (realtime.topic() like 'battle:%' and private.is_battle_player(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or (realtime.topic() like 'duel:%' and private.is_duel_participant(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or (realtime.topic() like 'room:%' and private.can_see_room(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or (realtime.topic() ~ '^turma:[0-9a-f-]{36}$' and private.is_member(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or (realtime.topic() ~ '^turma:[0-9a-f-]{36}:mods$' and private.is_moderator(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or realtime.topic() = 'user:' || auth.uid()::text
    )
  $p$;

  execute $p$
    create policy realtime_presence_send on realtime.messages for insert to authenticated
    with check (
      extension = 'presence' and (
        (realtime.topic() like 'battle:%' and private.is_battle_player(private.try_uuid(split_part(realtime.topic(), ':', 2))))
        or (realtime.topic() like 'duel:%' and private.is_duel_participant(private.try_uuid(split_part(realtime.topic(), ':', 2))))
        or (realtime.topic() like 'room:%' and private.is_room_member(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      )
    )
  $p$;
end $$;
