-- Phase 2 tables: Turma social, guardian supervision, schedule import, feed, motivation (MOT-01) and
-- Realtime authorization. Source: data-model.md §5.1 (guardian_*), §5.2 (schedule_imports), §5.3 (feed_*),
-- §5.7 (duels, battles, battle_players, quiz_shares, private.question_served, private.class_insights),
-- §5.9 (xp_events, daily_activity, streaks, achievements), §6.2 (matrix), §8 (Realtime);
-- spec 10 §6.2-6.3, spec 13 §6.2, ING-07.
-- Conventions as in 20260101000100_core.sql and 20260102000000_phase1.sql: text + CHECK enums, UUID v7 ids,
-- deleted_at tombstones on [sync] tables, [append] tables without updated_at and with forbid_mutation, RLS on
-- every table. RPCs are in 20260103000100_phase2_rpc.sql.
--
-- Access decisions beyond the matrix (see data-model §6.2):
--   * guardian_links and guardian_settings: students read only. Guardians have no profile and reach the
--     supervision panel through the service role, so no client can change the limits set for a student.
--   * battle_players: readable by every active member of the battle's Turma (lobby presence, SOC-03.3).
--   * battles and duels inserts and state changes: service role only (Edge Functions).

-- =====================================================================
-- 5.7 Social: duels and battles (SOC-02, SOC-03)
-- =====================================================================
create table public.duels (
  id                    uuid primary key default public.uuid_v7(),
  class_group_id        uuid not null references public.class_groups(id) on delete cascade,
  challenger_id         uuid not null references public.profiles(id) on delete cascade,
  opponent_id           uuid not null references public.profiles(id) on delete cascade,
  quiz_id               uuid not null references public.quizzes(id) on delete cascade,   -- same questions for both
  status                text not null default 'waiting_opponent'
                        check (status in ('waiting_opponent','declined','finished','expired','cancelled')),
  expires_at            timestamptz not null default now() + interval '48 hours',
  challenger_attempt_id uuid references public.quiz_attempts(id) on delete set null,
  opponent_attempt_id   uuid references public.quiz_attempts(id) on delete set null,
  challenger_score      int check (challenger_score >= 0),
  opponent_score        int check (opponent_score >= 0),
  winner_id             uuid references public.profiles(id) on delete set null,          -- null = tie
  rematch_of            uuid references public.duels(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (challenger_id <> opponent_id),
  check (winner_id is null or winner_id in (challenger_id, opponent_id))
);
create index duels_challenger on public.duels (challenger_id, status);
create index duels_opponent on public.duels (opponent_id, status);
create index duels_class on public.duels (class_group_id, created_at desc);

create table public.battles (
  id                   uuid primary key default public.uuid_v7(),
  class_group_id       uuid not null references public.class_groups(id) on delete cascade,
  host_id              uuid not null references public.profiles(id) on delete cascade,
  quiz_id              uuid not null references public.quizzes(id) on delete cascade,
  pin                  text not null check (pin ~ '^[0-9]{4}$'),
  status               text not null default 'lobby'
                       check (status in ('lobby','question_open','question_closed','reveal','podium','ended','cancelled')),
  current_index        int not null default 0 check (current_index >= 0),
  question_opens_at    timestamptz,
  question_closes_at   timestamptz,
  seconds_per_question int not null default 20 check (seconds_per_question between 5 and 60),
  ended_at             timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- SOC-03.2: the PIN is unique among live battles only.
create unique index battles_pin_live on public.battles (pin) where status not in ('ended','cancelled');
create index battles_class on public.battles (class_group_id, created_at desc);

create table public.battle_players (
  battle_id       uuid not null references public.battles(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  nickname        text not null check (char_length(nickname) between 2 and 24),   -- SOC-01.9
  score           int not null default 0 check (score >= 0),
  answer_streak   int not null default 0 check (answer_streak >= 0),
  joined_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  quiz_attempt_id uuid references public.quiz_attempts(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (battle_id, user_id)
);

-- SOC-09: a shared quiz. The token is the only public handle; the snapshot holds no answer keys.
create table public.quiz_shares (
  id          uuid primary key default public.uuid_v7(),
  quiz_id     uuid not null references public.quizzes(id) on delete cascade,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  token       text not null unique check (token ~ '^[A-Za-z0-9_-]{22}$'),
  snapshot    jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  expires_at  timestamptz not null default now() + interval '7 days',
  revoked_at  timestamptz,
  uses        int not null default 0 check (uses >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index quiz_shares_quiz on public.quiz_shares (quiz_id);

-- =====================================================================
-- 5.1 Guardian supervision (SP-03, SP-04). Written by the service role only.
-- =====================================================================
create table public.guardian_links (
  id                uuid primary key default public.uuid_v7(),
  student_id        uuid not null references public.profiles(id) on delete cascade,
  guardian_email    citext not null,
  guardian_user_id  uuid references auth.users(id) on delete set null,   -- set when the guardian signs in
  status            text not null default 'pending' check (status in ('pending','active','revoked')),
  verify_token_hash text not null,
  verified_at       timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'active' or (verified_at is not null and guardian_user_id is not null)),
  check (status <> 'revoked' or revoked_at is not null)
);
create unique index guardian_links_open_once on public.guardian_links (student_id, guardian_email)
  where status <> 'revoked';

create table public.guardian_settings (
  student_id      uuid primary key references public.profiles(id) on delete cascade,
  daily_limit_min int check (daily_limit_min between 10 and 1440),
  quiet_start     time,                                   -- a floor: effective quiet window = union with the student's
  quiet_end       time,
  updated_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- =====================================================================
-- 5.2 ING-07 schedule import: the extraction draft, applied by RPC apply_schedule_import
-- =====================================================================
create table public.schedule_imports (
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  extracted   jsonb not null default '[]'::jsonb check (jsonb_typeof(extracted) = 'array'),
  status      text not null default 'draft' check (status in ('draft','applied','discarded')),
  goal_id     uuid references public.goals(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index schedule_imports_user on public.schedule_imports (user_id, created_at desc);

-- =====================================================================
-- 5.3 Feed (FED-01)
-- =====================================================================
create table public.feed_items (                              -- [sync]
  id                    uuid primary key default public.uuid_v7(),
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  node_id               uuid not null references public.knowledge_nodes(id) on delete cascade,
  concept_id            uuid references public.knowledge_nodes(id) on delete set null,
  type                  text not null check (type in ('micro_lesson','quick_question','diagram','did_you_know')),
  content               jsonb not null check (jsonb_typeof(content) = 'object'),   -- per type, spec 06 §8.1
  media_path            text,                                                     -- media bucket
  source_pages          jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  external_knowledge    boolean not null default false,                           -- labelled in the UI
  personal_for_user_id  uuid references public.profiles(id) on delete cascade,    -- R8
  status                text not null default 'active' check (status in ('active','archived')),
  prompt_version        text,
  gen_batch_id          uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  check (type not in ('micro_lesson','quick_question') or concept_id is not null)
);
create index feed_items_sync on public.feed_items (updated_at, id);
create index feed_items_subject on public.feed_items (subject_id) where deleted_at is null;

create table public.feed_impressions (                        -- [append] client UUID; uploaded through sync-push
  id           uuid primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  feed_item_id uuid references public.feed_items(id) on delete set null,
  item_kind    text not null check (item_kind in ('feed_item','card','mistake')),
  item_ref_id  uuid not null,
  session_id   uuid references public.study_sessions(id) on delete set null,
  shown_at     timestamptz not null,
  dwell_ms     int not null default 0 check (dwell_ms >= 0),
  action       text not null check (action in ('answered','rated','read','skipped','hidden')),
  helpful      boolean,
  created_at   timestamptz not null default now()
);
create index feed_impressions_user on public.feed_impressions (user_id, shown_at);

-- =====================================================================
-- 5.9 Motivation (MOT-01)
-- =====================================================================
create table public.xp_events (                               -- [append] MOT-01, SOC-08
  id              uuid primary key,                           -- client UUID (idempotent sync)
  user_id         uuid not null references public.profiles(id) on delete cascade,
  amount          int not null check (amount > 0),
  source_feature  text not null check (char_length(source_feature) between 3 and 16),   -- PRD ID, e.g. MOT-01
  ref_type        text not null check (char_length(ref_type) between 1 and 40),
  ref_id          uuid not null,
  occurred_at     timestamptz not null,
  local_date      date not null,
  in_quiet_hours  boolean not null default false,
  created_at      timestamptz not null default now(),
  -- Prevents double awards (spec 13 §6.2, data-model §5.9).
  unique (user_id, ref_type, ref_id, source_feature)
);
create index xp_events_user_date on public.xp_events (user_id, local_date);

create table public.daily_activity (                          -- [svc] [sync: pull]
  user_id            uuid not null references public.profiles(id) on delete cascade,
  local_date         date not null,
  active_minutes     int not null default 0 check (active_minutes >= 0),
  reviews            int not null default 0 check (reviews >= 0),
  questions          int not null default 0 check (questions >= 0),
  sessions           int not null default 0 check (sessions >= 0),
  xp                 int not null default 0 check (xp >= 0),
  goal_minutes       int check (goal_minutes > 0),
  goal_met           boolean not null default false,
  counted            boolean not null default false,
  shield_used        boolean not null default false,
  rest_day           boolean not null default false,
  late_night_minutes int not null default 0 check (late_night_minutes >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  primary key (user_id, local_date)
);
create index daily_activity_sync on public.daily_activity (updated_at, user_id);

create table public.streaks (                                 -- [svc] [sync: pull]
  user_id                       uuid primary key references public.profiles(id) on delete cascade,
  current_length                int not null default 0 check (current_length >= 0),
  longest_length                int not null default 0 check (longest_length >= 0),
  last_counted_date             date,
  shields_available             smallint not null default 0 check (shields_available between 0 and 2),
  days_since_last_shield_earned int not null default 0 check (days_since_last_shield_earned >= 0),
  rest_weekday                  smallint check (rest_weekday between 0 and 6),
  reset_notice_pending          boolean not null default false,   -- the reset message is shown once (MOT-01.5)
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  deleted_at                    timestamptz,
  check (longest_length >= current_length)
);
create index streaks_sync on public.streaks (updated_at, user_id);

create table public.achievements (                            -- [sync] MOT-01.8, private unless shown in the Turma
  user_id       uuid not null references public.profiles(id) on delete cascade,
  code          text not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),   -- definitions live in packages/shared
  progress      int not null default 0 check (progress >= 0),
  unlocked_at   timestamptz,
  show_in_turma boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (user_id, code),
  check (not show_in_turma or unlocked_at is not null)
);
create index achievements_sync on public.achievements (updated_at, user_id);

-- =====================================================================
-- Private schema (never exposed through the API): duel timing and Turma insight aggregates
-- =====================================================================
create table private.question_served (                        -- SOC-02.4, SOC-03.5 (service only)
  quiz_attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id     uuid not null references public.questions(id) on delete cascade,
  served_at       timestamptz not null default now(),
  deadline_at     timestamptz not null,
  primary key (quiz_attempt_id, question_id),
  check (deadline_at >= served_at)
);

-- Reserved for the insights.recompute job (api.md §7). class_insights_for aggregates live from
-- attempt_answers, so an opt-out (SOC-04.6) takes effect at once; this table is not read by the RPC.
create table private.class_insights (                         -- SOC-04 (R11)
  id             uuid primary key default public.uuid_v7(),
  class_group_id uuid not null references public.class_groups(id) on delete cascade,
  question_id    uuid references public.questions(id) on delete cascade,
  node_id        uuid references public.knowledge_nodes(id) on delete cascade,
  n_answered     int not null default 0 check (n_answered >= 0),
  n_wrong        int not null default 0 check (n_wrong >= 0),
  option_counts  jsonb not null default '{}'::jsonb check (jsonb_typeof(option_counts) = 'object'),
  computed_at    timestamptz not null default now(),
  check (question_id is not null or node_id is not null),
  check (n_wrong <= n_answered)
);
create unique index class_insights_key on private.class_insights
  (class_group_id, coalesce(question_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(node_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- =====================================================================
-- Helpers for policies, triggers and Realtime (security definer, stable, search_path = '')
-- =====================================================================
create or replace function private.can_see_battle(p_battle uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.battles b
                 where b.id = p_battle and private.is_member(b.class_group_id));
$$;

create or replace function private.is_battle_player(p_battle uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.battles b where b.id = p_battle and b.host_id = auth.uid())
      or exists (select 1 from public.battle_players bp
                  where bp.battle_id = p_battle and bp.user_id = auth.uid());
$$;

create or replace function private.is_duel_participant(p_duel uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.duels d
                 where d.id = p_duel and auth.uid() in (d.challenger_id, d.opponent_id));
$$;

-- A duel needs two active members of the Turma, the opponent accepting duels (SOC-02.12), and no block
-- in either direction (SOC-02.11). Edge Functions also check this; the database keeps it true for every writer.
create or replace function private.duels_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.class_group_members m
                  where m.class_group_id = new.class_group_id and m.user_id = new.challenger_id and m.status = 'active')
     or not exists (select 1 from public.class_group_members m
                     where m.class_group_id = new.class_group_id and m.user_id = new.opponent_id and m.status = 'active') then
    raise exception 'both players must be active members of the Turma' using errcode = 'P0001', hint = 'not_member';
  end if;
  if not exists (select 1 from public.class_group_members m
                  where m.class_group_id = new.class_group_id and m.user_id = new.opponent_id and m.accepts_duels) then
    raise exception 'the opponent does not accept duels' using errcode = 'P0001', hint = 'forbidden';
  end if;
  if exists (select 1 from public.user_blocks b
              where (b.blocker_id = new.challenger_id and b.blocked_id = new.opponent_id)
                 or (b.blocker_id = new.opponent_id and b.blocked_id = new.challenger_id)) then
    raise exception 'the users have blocked each other' using errcode = 'P0001', hint = 'blocked';
  end if;
  return new;
end $$;

create trigger duels_guard_insert before insert on public.duels
  for each row execute function private.duels_guard();

-- Battle players must be active members of the battle's Turma (SOC-03.2).
create or replace function private.battle_players_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.battles b
                   join public.class_group_members m on m.class_group_id = b.class_group_id
                  where b.id = new.battle_id and m.user_id = new.user_id and m.status = 'active') then
    raise exception 'only members of the Turma can join a battle' using errcode = 'P0001', hint = 'not_member';
  end if;
  return new;
end $$;

create trigger battle_players_guard_insert before insert on public.battle_players
  for each row execute function private.battle_players_guard();

-- SOC-01/MOT-01: a member card shows at most 3 achievements.
create or replace function private.achievements_show_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.show_in_turma and (tg_op = 'INSERT' or not coalesce(old.show_in_turma, false)) then
    if (select count(*) from public.achievements a
         where a.user_id = new.user_id and a.code <> new.code and a.show_in_turma and a.deleted_at is null) >= 3 then
      raise exception 'at most 3 achievements can be shown in a Turma' using errcode = 'P0001', hint = 'invalid_request';
    end if;
  end if;
  return new;
end $$;

create trigger achievements_show_limit_guard before insert or update of show_in_turma on public.achievements
  for each row execute function private.achievements_show_limit();

-- updated_at maintenance (data-model §1.1) for every Phase 2 table that has the column.
do $$
declare
  t text;
begin
  foreach t in array array[
    'duels','battles','battle_players','quiz_shares','guardian_links','guardian_settings','schedule_imports',
    'feed_items','daily_activity','streaks','achievements'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

create trigger feed_impressions_append_only before update or delete on public.feed_impressions
  for each row execute function private.forbid_mutation();
create trigger xp_events_append_only before update or delete on public.xp_events
  for each row execute function private.forbid_mutation();

-- Realtime (data-model §8.1): the duel state the app shows live. Other Phase 2 tables are
-- broadcast on Realtime channels instead (§8.2), so they stay out of the publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.duels;
  end if;
end $$;

-- =====================================================================
-- Row Level Security and grants (data-model §6.2). Clients get only what their policies allow.
-- =====================================================================

-- ---- duels (participants read; the Edge Functions write) -----------------
alter table public.duels enable row level security;
revoke all on public.duels from anon, authenticated;
grant select on public.duels to authenticated;
create policy duels_select_participant on public.duels for select to authenticated
  using (auth.uid() in (challenger_id, opponent_id));

-- duel_participants_public: display name and score of the two players, for the duel's participants only.
-- The view runs as its owner, so the WHERE clause is the access control (same pattern as profiles_public).
create view public.duel_participants_public with (security_barrier = true) as
  select d.id as duel_id, d.challenger_id as user_id,
         case when p.display_name_status = 'approved' then p.display_name end as display_name,
         d.challenger_score as score
    from public.duels d
    join public.profiles p on p.id = d.challenger_id
   where p.deleted_at is null and auth.uid() in (d.challenger_id, d.opponent_id)
  union all
  select d.id, d.opponent_id,
         case when p.display_name_status = 'approved' then p.display_name end,
         d.opponent_score
    from public.duels d
    join public.profiles p on p.id = d.opponent_id
   where p.deleted_at is null and auth.uid() in (d.challenger_id, d.opponent_id);
revoke all on public.duel_participants_public from anon, authenticated;
grant select on public.duel_participants_public to authenticated;

-- ---- battles (Turma members see the lobby; hosts and Turma members read) ---------
alter table public.battles enable row level security;
revoke all on public.battles from anon, authenticated;
grant select on public.battles to authenticated;
create policy battles_select on public.battles for select to authenticated
  using (private.is_member(class_group_id) or host_id = auth.uid() or private.is_battle_player(id));

-- ---- battle_players (Turma members; the Edge Functions write) ------------------
alter table public.battle_players enable row level security;
revoke all on public.battle_players from anon, authenticated;
grant select on public.battle_players to authenticated;
create policy battle_players_select on public.battle_players for select to authenticated
  using (private.can_see_battle(battle_id));

-- ---- quiz_shares (creator only, SOC-09) ----------------------------------------
alter table public.quiz_shares enable row level security;
revoke all on public.quiz_shares from anon, authenticated;
grant select on public.quiz_shares to authenticated;
grant insert (quiz_id, created_by, token, snapshot, expires_at) on public.quiz_shares to authenticated;
grant update (revoked_at) on public.quiz_shares to authenticated;   -- uses is counted by the service
create policy quiz_shares_select_own on public.quiz_shares for select to authenticated
  using (created_by = auth.uid());
create policy quiz_shares_insert_own on public.quiz_shares for insert to authenticated
  with check (created_by = auth.uid()
              and exists (select 1 from public.quizzes q
                          where q.id = quiz_id and q.owner_id = auth.uid() and q.deleted_at is null));
create policy quiz_shares_update_own on public.quiz_shares for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- ---- guardian_links (the student sees who supervises them; service role writes) -----
alter table public.guardian_links enable row level security;
revoke all on public.guardian_links from anon, authenticated;
grant select on public.guardian_links to authenticated;
create policy guardian_links_select_student on public.guardian_links for select to authenticated
  using (student_id = auth.uid());

-- ---- guardian_settings (the student reads the limits set for them) ---------------
alter table public.guardian_settings enable row level security;
revoke all on public.guardian_settings from anon, authenticated;
grant select on public.guardian_settings to authenticated;
create policy guardian_settings_select_student on public.guardian_settings for select to authenticated
  using (student_id = auth.uid());

-- ---- schedule_imports (own draft; apply_schedule_import changes it) ------------
alter table public.schedule_imports enable row level security;
revoke all on public.schedule_imports from anon, authenticated;
grant select on public.schedule_imports to authenticated;
create policy schedule_imports_select_own on public.schedule_imports for select to authenticated
  using (user_id = auth.uid());

-- ---- feed_items (readable like cards; generated by the service) ----------------
alter table public.feed_items enable row level security;
revoke all on public.feed_items from anon, authenticated;
grant select on public.feed_items to authenticated;
create policy feed_items_select on public.feed_items for select to authenticated
  using (status = 'active' and private.can_read_item(subject_id, personal_for_user_id));

-- ---- feed_impressions (append-only; sync-push inserts) ---------------------------
alter table public.feed_impressions enable row level security;
revoke all on public.feed_impressions from anon, authenticated;
grant select on public.feed_impressions to authenticated;
create policy feed_impressions_select_own on public.feed_impressions for select to authenticated
  using (user_id = auth.uid());

-- ---- xp_events (append-only; sync-push and xp.award insert) -----------------------
alter table public.xp_events enable row level security;
revoke all on public.xp_events from anon, authenticated;
grant select on public.xp_events to authenticated;
create policy xp_events_select_own on public.xp_events for select to authenticated
  using (user_id = auth.uid());

-- ---- daily_activity and streaks (derived; rollover job writes) -------------------
alter table public.daily_activity enable row level security;
revoke all on public.daily_activity from anon, authenticated;
grant select on public.daily_activity to authenticated;
create policy daily_activity_select_own on public.daily_activity for select to authenticated
  using (user_id = auth.uid());

alter table public.streaks enable row level security;
revoke all on public.streaks from anon, authenticated;
grant select on public.streaks to authenticated;
create policy streaks_select_own on public.streaks for select to authenticated
  using (user_id = auth.uid());

-- ---- achievements (own; the user may show up to 3 on the Turma card) ------------
alter table public.achievements enable row level security;
revoke all on public.achievements from anon, authenticated;
grant select on public.achievements to authenticated;
grant update (show_in_turma) on public.achievements to authenticated;
create policy achievements_select_own on public.achievements for select to authenticated
  using (user_id = auth.uid());
create policy achievements_select_turma on public.achievements for select to authenticated
  using (show_in_turma and unlocked_at is not null and deleted_at is null and private.shares_class_with(user_id));
create policy achievements_update_own on public.achievements for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- private tables: RLS on, service role only ------------------------------------
alter table private.question_served enable row level security;
alter table private.class_insights enable row level security;
revoke all on private.question_served, private.class_insights from public, anon, authenticated;
grant all on private.question_served, private.class_insights to service_role;

-- Helpers used by policies and Realtime: callable by signed-in users, never by anon.
revoke all on function private.can_see_battle(uuid), private.is_battle_player(uuid), private.is_duel_participant(uuid)
  from public, anon;
grant execute on function private.can_see_battle(uuid), private.is_battle_player(uuid), private.is_duel_participant(uuid)
  to authenticated, service_role;

-- =====================================================================
-- Realtime authorization (data-model §8.2, api.md §8). Guarded: the local shim provides realtime.messages and
-- realtime.topic(); Supabase always does. Channels are private; clients may only send presence.
--   battle:{battle_id}            players and the host. Stricter than spec 10 §6.3 (every Turma member).
--   duel:{duel_id}                the two participants
--   turma:{class_group_id}        active members (api.md §8 name; data-model §8.2)
--   turma:{class_group_id}:mods   owners and moderators
--   user:{user_id}               the user itself
-- =====================================================================
do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages or realtime.topic() is missing; channel policies were not created';
    return;
  end if;

  -- Same as storage.objects: hosted Supabase owns realtime.messages and usually has RLS on already.
  if not (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass) then
    execute 'alter table realtime.messages enable row level security';
  end if;

  execute $p$
    create policy realtime_private_read on realtime.messages for select to authenticated
    using (
      (realtime.topic() like 'battle:%' and private.is_battle_player(private.try_uuid(split_part(realtime.topic(), ':', 2))))
      or (realtime.topic() like 'duel:%' and private.is_duel_participant(private.try_uuid(split_part(realtime.topic(), ':', 2))))
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
      )
    )
  $p$;
end $$;
