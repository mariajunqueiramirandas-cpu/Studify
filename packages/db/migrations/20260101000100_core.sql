-- Core schema, Phase 0-1 (+ the platform, AI-ops and Subjects tables listed in the foundation plan).
-- Source: docs/engineering/data-model.md §4 (verbatim unless noted), §5.1, §5.2, §5.5 (plan_runs only,
-- for the plan_items FK), §5.11, §6.2, §6.3; security-privacy.md §4, §9.
--
-- Conventions: text + CHECK enums, UUID v7 ids (public.uuid_v7()), timestamptz UTC, RLS on every table.
-- Clients get only the grants their policies need (least privilege); writes that the matrix
-- assigns to the service role or to RPCs have no client grant at all.

-- =====================================================================
-- 4.1 Identity and Turma
-- =====================================================================
create table public.profiles (
  id                      uuid primary key references auth.users(id) on delete cascade,
  display_name            text not null check (char_length(display_name) between 2 and 30),  -- PLT-02.5
  display_name_status     text not null default 'pending' check (display_name_status in ('pending','approved','rejected')), -- SP-11 moderation
  avatar_preset           text,                                   -- preset avatar id (no uploads in v1, PLT-02.5)
  avatar_path             text,                                   -- avatars bucket (later phase)
  birth_year              smallint not null check (birth_year between 1950 and 2100),   -- SP-01 age gate
  birth_month             smallint not null check (birth_month between 1 and 12),
  school_year             text check (school_year in ('ef9','em1','em2','em3','cursinho','outro')),  -- no school name (data minimization)
  timezone                text not null default 'America/Sao_Paulo',
  foreign_language        text check (foreign_language in ('en','es')),                 -- ENM-01
  app_role                text not null default 'user' check (app_role in ('user','app_admin')),  -- app_admin = owner (PLT-04.6, moderation escalation, ENEM curation)
  invite_id               uuid,                                   -- invites.id used at sign-up (SP-02 pilot gating)
  privacy_notice_version  text not null,                          -- PLT-02.7
  privacy_accepted_at     timestamptz not null,
  settings                jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'), -- ProfileSettings, data-model §5.1
  onboarding_completed_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

create table public.class_groups (
  id                         uuid primary key default public.uuid_v7(),
  name                       text not null check (char_length(name) between 2 and 60),
  owner_id                   uuid not null references public.profiles(id),
  school                     text,
  school_year                text,
  join_policy                text not null default 'approval' check (join_policy in ('approval','open')), -- SOC-01.5; default is an owner decision
  member_cap                 int not null default 60 check (member_cap between 2 and 60),  -- SOC-01.7
  allow_member_uploads       boolean not null default false,                          -- security §4.2 "if the Turma allows member uploads"
  ai_budget_monthly_micro_usd bigint check (ai_budget_monthly_micro_usd >= 0),        -- PLT-04 (read by private.ai_budget_limit)
  settings                   jsonb not null default '{}'::jsonb,                       -- {duels_enabled, battles_host: 'owner_mods'|'anyone', ...}
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz
);

-- One table for pilot invites and Turma invites (R23). A Turma's current link = its newest non-revoked invite.
create table public.invites (
  id             uuid primary key default public.uuid_v7(),
  code           text not null unique check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$'),  -- 8 chars, no 0/O/1/I/L (security §9)
  created_by     uuid not null references public.profiles(id),
  class_group_id uuid references public.class_groups(id) on delete cascade, -- null = owner (pilot) invite
  email          citext,                                                    -- optional: bound to one email
  uses_left      int check (uses_left >= 0),                                -- null = unlimited (until member_cap)
  expires_at     timestamptz not null default now() + interval '7 days',
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index invites_group on public.invites (class_group_id) where revoked_at is null;
alter table public.profiles add constraint profiles_invite_fk foreign key (invite_id) references public.invites(id) on delete set null;

create table public.class_group_members (
  class_group_id      uuid not null references public.class_groups(id) on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  role                text not null default 'member' check (role in ('owner','moderator','member')),
  status              text not null default 'pending' check (status in ('pending','active','removed','banned','left')),
  nickname            text check (char_length(nickname) between 1 and 30),            -- SOC-01.9 (moderated)
  approved_by         uuid references public.profiles(id),
  joined_at           timestamptz,
  left_at             timestamptz,
  contribute_insights boolean not null default true,                                   -- SOC-04.6
  league_opt_in       boolean not null default false,                                  -- SOC-08.1 (opt-in, SP-05)
  accepts_duels       boolean not null default true,                                   -- SOC-02.12
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (class_group_id, user_id)
);
create index class_group_members_user_active on public.class_group_members (user_id) where status = 'active';
create unique index class_group_members_one_owner on public.class_group_members (class_group_id) where role = 'owner' and status = 'active';

-- =====================================================================
-- 4.2 Subjects, documents, knowledge map
-- =====================================================================
create table public.subjects (
  id                   uuid primary key default public.uuid_v7(),
  owner_profile_id     uuid references public.profiles(id) on delete cascade,
  owner_class_group_id uuid references public.class_groups(id) on delete cascade,
  created_by           uuid not null references public.profiles(id),     -- keeps edit rights after sharing (SOC-01.10)
  name                 text not null check (char_length(name) between 1 and 60),
  color                text not null check (color ~ '^#[0-9A-Fa-f]{6}$'),
  icon                 text not null,
  content_language     text,                                             -- BCP 47 (ING-05.2)
  is_language_subject  boolean not null default false,                   -- ING-05.3
  enem_area            text check (enem_area in ('LC','CH','CN','MT')),  -- ENM-01 / PLT-03.7
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  check (num_nonnulls(owner_profile_id, owner_class_group_id) = 1)
);
create index subjects_owner_profile on public.subjects (owner_profile_id) where deleted_at is null;
create index subjects_owner_group   on public.subjects (owner_class_group_id) where deleted_at is null;

create table public.documents (
  id                   uuid primary key default public.uuid_v7(),
  subject_id           uuid not null references public.subjects(id) on delete cascade,
  uploaded_by          uuid references public.profiles(id) on delete set null,  -- "ex-membro" after account deletion
  title                text not null check (char_length(title) between 1 and 200),
  kind                 text not null check (kind in ('slides','notes','textbook','past_test','content_list','photo','other')),
  detected_kind        text check (detected_kind in ('slides','notes','textbook','past_test','content_list','photo','other')),
  storage_path         text not null,                       -- documents/{subject_id}/{document_id}.pdf or photos/...
  mime_type            text not null default 'application/pdf',
  size_bytes           bigint not null check (size_bytes > 0),
  page_count           int check (page_count between 1 and 1000),
  checksum_sha256      text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  language             text,                                -- BCP 47 from S1
  has_bookmarks        boolean,
  status               text not null default 'uploaded'
                       check (status in ('uploaded','processing','ready','failed','waiting_budget')),
  error_code           text check (error_code in ('password_protected','corrupt','empty','too_large','too_many_pages',
                                                  'not_study_material','ai_failed','ai_refused','unsupported_type')),
  teacher_name         text,                                -- PRA-09 (R22)
  exam_year            smallint,                            -- PRA-09 past tests
  exam_term            smallint,
  integrity_confirmed  boolean not null default false,      -- PRA-09.1 "the test already happened"
  copyright_ack_at     timestamptz,                         -- security §11 upload confirmation in shared subjects
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create unique index documents_subject_checksum on public.documents (subject_id, checksum_sha256) where deleted_at is null;
create index documents_subject on public.documents (subject_id) where deleted_at is null;

create table public.document_pages (
  document_id              uuid not null references public.documents(id) on delete cascade,
  page_number              int not null check (page_number >= 1),
  text                     text,
  text_source              text not null default 'none' check (text_source in ('pdf_text_layer','ai_transcription','none')),
  transcription_confidence text check (transcription_confidence in ('high','medium','low')),
  char_count               int not null default 0,
  has_images               boolean not null default false,
  thumbnail_path           text,           -- page-images bucket, ~50 dpi (ING-02.4)
  image_path               text,           -- page-images bucket, ~1600 px (citation view)
  text_items_path          text,           -- page-text bucket: positioned spans with normalized bboxes (ING-08 highlight)
  ts_config                regconfig not null default 'portuguese',
  tsv                      tsvector generated always as (to_tsvector(ts_config, private.f_unaccent(coalesce(text, '')))) stored,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (document_id, page_number)
);
create index document_pages_tsv on public.document_pages using gin (tsv);

create table public.knowledge_nodes (
  id                  uuid primary key default public.uuid_v7(),
  subject_id          uuid not null references public.subjects(id) on delete cascade,
  parent_id           uuid references public.knowledge_nodes(id) on delete cascade,
  kind                text not null check (kind in ('unit','topic','concept')),
  title               text not null check (char_length(title) between 1 and 200),
  summary             text,
  position            int not null default 0,                    -- order among siblings
  learning_objectives text[] not null default '{}',
  key_terms           text[] not null default '{}',              -- glossary seed (ING-03)
  formulas            jsonb not null default '[]'::jsonb check (jsonb_typeof(formulas) = 'array'), -- Formula[]
  enem_skill_codes    text[] not null default '{}',              -- ENM-01.4, e.g. {'CN-H17'}
  is_placeholder      boolean not null default false,            -- GOL-03.4 topic from a content list with no material
  est_learn_minutes   int check (est_learn_minutes > 0),         -- GOL-04 §8.2.2 cache
  edited_by_user      boolean not null default false,            -- protects edits during merges (ING-01 merge)
  origin_document_id  uuid references public.documents(id) on delete set null,
  content_status      text not null default 'pending'
                      check (content_status in ('pending','generating','ready','failed','skipped_excluded')),
  version             int not null default 1,                    -- TRU-02
  hidden_reason       text check (hidden_reason in ('under_review','removed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  check ((kind = 'unit') = (parent_id is null))   -- units are the only roots; topics/concepts always have a parent
);
create index knowledge_nodes_tree on public.knowledge_nodes (subject_id, parent_id, position) where deleted_at is null;
create index knowledge_nodes_sync on public.knowledge_nodes (updated_at, id);
create index knowledge_nodes_title_trgm on public.knowledge_nodes using gin (private.f_unaccent(title) gin_trgm_ops);

-- =====================================================================
-- 4.3 Cards, review state, questions
-- =====================================================================
create table public.cards (
  id                   uuid primary key default public.uuid_v7(),
  subject_id           uuid not null references public.subjects(id) on delete cascade,   -- denormalized for RLS + sync filter
  node_id              uuid not null references public.knowledge_nodes(id) on delete cascade,  -- topic
  concept_id           uuid references public.knowledge_nodes(id) on delete set null,     -- concept tested (MEM-05 map)
  type                 text not null check (type in ('basic','cloze','reverse','image_occlusion')),
  front                text not null,                       -- Markdown + KaTeX
  back                 text not null,
  media                jsonb,                               -- Media
  has_math             boolean not null default false,      -- mobile-app.md §8
  sibling_group_id     uuid,                                -- cloze siblings, reverse pairs, occlusion masks (burying)
  cloze_index          smallint check (cloze_index >= 1),
  source_pages         jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),  -- SourcePages
  origin               text not null check (origin in ('generated','user','from_mistake','from_tutor')),
  created_by           uuid references public.profiles(id) on delete set null,
  personal_for_user_id uuid references public.profiles(id) on delete cascade,  -- R8: private card inside a shared subject
  status               text not null default 'active' check (status in ('active','archived')),
  hidden_reason        text check (hidden_reason in ('under_review','removed')),
  version              int not null default 1,
  prompt_version       text,
  gen_batch_id         uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index cards_node on public.cards (node_id) where deleted_at is null;
create index cards_subject_sync on public.cards (subject_id, updated_at, id);

create table public.card_states (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  card_id         uuid not null references public.cards(id) on delete cascade,
  subject_id      uuid not null references public.subjects(id) on delete cascade,  -- denormalized for sync filter
  due             timestamptz not null,
  stability       double precision not null default 0,
  difficulty      double precision not null default 0,
  elapsed_days    int not null default 0,
  scheduled_days  int not null default 0,
  reps            int not null default 0,
  lapses          int not null default 0,
  state           smallint not null default 0 check (state between 0 and 3),  -- ts-fsrs State: 0 New, 1 Learning, 2 Review, 3 Relearning
  learning_steps  int not null default 0,
  last_review     timestamptz,
  suspended       boolean not null default false,
  hidden          boolean not null default false,       -- "Excluir pra mim" (R7)
  is_leech        boolean not null default false,
  introduced_at   timestamptz,                          -- left New (new-card quota)
  last_log_id     uuid,                                 -- last review_logs.id folded into this state (replay checkpoint)
  updated_at      timestamptz not null default now(),
  primary key (user_id, card_id)
);
create index card_states_due on public.card_states (user_id, due) where not suspended and not hidden;
create index card_states_sync on public.card_states (user_id, updated_at);

create table public.review_logs (                       -- [append] ADR 0007
  id                 uuid primary key,                   -- client-generated UUID v7 (idempotency key)
  user_id            uuid not null references public.profiles(id) on delete cascade,
  card_id            uuid not null references public.cards(id) on delete cascade,
  rating             smallint not null check (rating between 1 and 4),   -- 1 Errei, 2 Difícil, 3 Bom, 4 Fácil
  reviewed_at        timestamptz not null,                -- server-clamped
  client_reviewed_at timestamptz not null,                -- raw device time
  elapsed_days       int,
  scheduled_days     int,
  state_before       smallint check (state_before between 0 and 3),
  duration_ms        int check (duration_ms >= 0),
  source             text not null default 'session'
                     check (source in ('session','feed','widget','notification','map','vespera')),
  reason             text not null default 'scheduled' check (reason in ('scheduled','exam_boost','early')),
  hint_used          boolean not null default false,      -- MEM-06.4
  undoes_log_id      uuid references public.review_logs(id), -- MEM-02.8 undo marker
  device_id          text,
  clock_skew         boolean not null default false,      -- testing-strategy.md: > 5 min in the future at receipt
  schema_version     smallint not null default 1,
  created_at         timestamptz not null default now()
);
create index review_logs_replay on public.review_logs (user_id, card_id, reviewed_at);

create table public.questions (
  id                    uuid primary key default public.uuid_v7(),
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  node_id               uuid not null references public.knowledge_nodes(id) on delete cascade,
  concept_ids           uuid[] not null default '{}',
  type                  text not null check (type in ('mcq_single','multi_select','true_false','fill_blank','numeric',
                                                      'matching','ordering','short_answer','essay_question','find_error','problem')),
  stem                  text not null,                     -- Markdown
  stimulus              jsonb,                             -- {markdown?, image_path?, table_markdown?}
  texto_base            jsonb,                             -- ENM-03 {kind, content_md, chart_data?, source_pages?, label?}
  payload               jsonb not null check (jsonb_typeof(payload) = 'object'),   -- QuestionPayload by type (spec 05 §8.1)
  explanation           text,
  bloom_level           text check (bloom_level in ('remember','understand','apply','analyze','evaluate','create')),
  difficulty            smallint check (difficulty between 1 and 5),
  difficulty_band       text check (difficulty_band in ('facil','media','dificil','muito_dificil')),  -- ENEM bands
  empirical_difficulty  real check (empirical_difficulty between 0 and 1),   -- after >= 20 first attempts (PRA §8.10)
  empirical_n           int not null default 0,
  fixed_order           boolean not null default false,
  has_math              boolean not null default false,
  source_pages          jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  origin                text not null check (origin in ('generated','past_test','enem_official','peer','photo','user')),
  variant_of            uuid references public.questions(id) on delete set null,
  source_document_id    uuid references public.documents(id) on delete set null,   -- PRA-09 past test
  source_capture_id     uuid,                              -- CAM-02.9 (FK added with camera_captures, Phase 3)
  position              int,                               -- question number in the original test
  points                numeric,
  format_features       text[] not null default '{}',      -- contextualized, figure, graph, table, calculation, multi_part
  answer_key_source     text check (answer_key_source in ('printed','generated','official')),
  node_match_confidence real,
  rationale             text,                              -- "Por que essa questão?" (predicted tests)
  enem_skill_code       text,                              -- e.g. 'MT-H21'
  enem_style            boolean not null default false,
  author_id             uuid references public.profiles(id) on delete set null,     -- SOC-07 peer questions
  author_anonymous      boolean not null default false,
  personal_for_user_id  uuid references public.profiles(id) on delete cascade,      -- R8
  review_status         text not null default 'approved' check (review_status in ('approved','pending','rejected')),
  status                text not null default 'active' check (status in ('active','archived','disputed')),
  hidden_reason         text check (hidden_reason in ('under_review','removed')),
  version               int not null default 1,
  prompt_version        text,
  gen_batch_id          uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index questions_node on public.questions (node_id) where deleted_at is null and status = 'active';
create index questions_subject_sync on public.questions (subject_id, updated_at, id);
create index questions_concepts on public.questions using gin (concept_ids);

-- =====================================================================
-- 4.4 Goals, exams, plan
-- =====================================================================
create table public.goals (
  id           uuid primary key default public.uuid_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  mode         text not null check (mode in ('exam_week','enem')),
  name         text not null check (char_length(name) between 1 and 80),
  start_date   date not null,
  end_date     date not null check (end_date >= start_date),
  status       text not null default 'active' check (status in ('active','completed','archived')),  -- GOL-01.5
  term_index   smallint check (term_index between 1 and 4),          -- GOL-06
  school_year  smallint,                                              -- calendar year of the school year
  settings     jsonb not null default '{}'::jsonb,                    -- GoalSettings: {enem_edition?, language?, sisu_target_id?, ...}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index goals_user_active on public.goals (user_id) where status = 'active' and deleted_at is null;

create table public.exams (
  id             uuid primary key default public.uuid_v7(),
  goal_id        uuid not null references public.goals(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,   -- denormalized for RLS
  subject_id     uuid references public.subjects(id) on delete set null,          -- null until the student picks/creates one
  title          text not null,
  local_date     date not null,                     -- planning uses this
  starts_at      timestamptz,                       -- null = "horário a definir"
  duration_min   int check (duration_min > 0),
  kind           text not null default 'regular' check (kind in ('regular','recuperacao','final')),
  status         text not null default 'scheduled' check (status in ('draft','scheduled','done','cancelled')),  -- draft from ING-07
  parent_exam_id uuid references public.exams(id) on delete set null,             -- recuperação → original
  teacher_name   text,
  weight         numeric check (weight > 0),        -- planner override; else derived from grade_components
  scope_status   text not null default 'none' check (scope_status in ('none','pending_review','confirmed')),
  grade          numeric check (grade >= 0),
  grade_max      numeric check (grade_max > 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index exams_goal on public.exams (goal_id, local_date) where deleted_at is null;
create index exams_user_upcoming on public.exams (user_id, local_date) where status = 'scheduled' and deleted_at is null;

-- plan_runs (data-model §5.5, Phase 1): needed by plan_items.plan_run_id.
create table public.plan_runs (
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  version     int not null check (version >= 1),
  trigger     text not null check (trigger in ('goal_created','exam_changed','scope_changed','day_missed','grade_logged',
                                              'user_rebalance','nightly','availability_changed','material_added',
                                              'desperate_on','desperate_off')),
  input_hash  text not null,
  feasible    boolean not null default true,
  triage      jsonb not null default '{}'::jsonb check (jsonb_typeof(triage) = 'object'),
  computed_by text not null default 'server' check (computed_by in ('server','device')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, version)
);

create table public.plan_items (
  id             uuid primary key default public.uuid_v7(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  goal_id        uuid references public.goals(id) on delete cascade,   -- null for cross-goal review blocks
  plan_run_id    uuid not null references public.plan_runs(id) on delete cascade,
  local_date     date not null,
  subject_id     uuid references public.subjects(id) on delete set null,
  exam_id        uuid references public.exams(id) on delete set null,
  node_ids       uuid[] not null default '{}',
  unit_type      text not null check (unit_type in ('learn','learn_light','practice','mock','vespera','warmup',
                                                     'review','upload_material','essay')),
  minutes        int not null check (minutes between 1 and 240),
  deadline       date,
  priority       numeric not null default 0,
  order_in_day   int not null default 0,
  demanding      boolean not null default false,
  pinned         boolean not null default false,            -- user-pinned; never moved by replanning
  status         text not null default 'planned' check (status in ('planned','done','skipped','moved')),
  reason_key     text,                                      -- ReasonRef.key (i18n)
  reason_params  jsonb,
  completed_session_id uuid,                                -- study_sessions.id
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index plan_items_user_day on public.plan_items (user_id, local_date) where deleted_at is null;

-- =====================================================================
-- 5.1 Identity, Turma, safety (platform tables)
-- =====================================================================
create table public.study_preferences (                 -- [sync] GOL-04, GOL-10, MEM-04, PLT-05, WEL-03
  user_id                 uuid primary key references public.profiles(id) on delete cascade,
  minutes_by_weekday      int[] not null default '{60,60,60,60,60,90,30}' check (array_length(minutes_by_weekday, 1) = 7),
  window_start            time not null default '14:00',
  window_end              time not null default '21:30',
  min_block_min           int not null default 15 check (min_block_min > 0),
  max_block_min           int not null default 45 check (max_block_min >= min_block_min),
  max_subjects_per_day    int not null default 3 check (max_subjects_per_day > 0),
  quiet_start             time not null default '22:00',     -- R9 canonical quiet hours
  quiet_end               time not null default '07:00',
  vespera_time            time not null default '19:00',
  day_rollover_hour      smallint not null default 4 check (day_rollover_hour between 0 and 6),  -- R9
  enem_min_share          real not null default 0.2 check (enem_min_share between 0 and 1),
  review_seconds_estimate real not null default 8 check (review_seconds_estimate > 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
create index study_preferences_sync on public.study_preferences (updated_at, user_id);

create table public.push_tokens (
  id             uuid primary key default public.uuid_v7(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  token          text not null unique,                       -- Expo push token
  device_id      text not null,
  platform       text not null default 'android' check (platform in ('android','ios')),
  app_version    text,
  last_seen_at   timestamptz not null default now(),         -- tokens unseen for 60 days are pruned
  invalidated_at timestamptz,                                 -- sign-out, account deletion, DeviceNotRegistered
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index push_tokens_one_active_per_device on public.push_tokens (user_id, device_id) where invalidated_at is null;

create table public.notification_log (                      -- [svc] PLT-05.3, PLT-05.4
  id                 uuid primary key default public.uuid_v7(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  type               text not null,
  channel            text not null check (channel in ('reviews','plan','class','processing')),
  counts_toward_cap  boolean not null default false,
  scheduled_for      timestamptz not null,
  sent_at            timestamptz,
  dropped_reason     text check (dropped_reason in ('daily_cap','quiet_hours_superseded','disabled','no_token')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index notification_log_user_time on public.notification_log (user_id, scheduled_for);

create table public.user_blocks (                           -- security §9
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.user_reports (                          -- SP-09, SOC
  id              uuid primary key default public.uuid_v7(),
  reporter_id     uuid not null references public.profiles(id) on delete cascade,
  reported_id     uuid references public.profiles(id) on delete cascade,      -- null when the report is about content only
  class_group_id  uuid references public.class_groups(id) on delete cascade,  -- null only for reports outside a Turma
  reason          text not null check (reason in ('harassment','inappropriate_name','inappropriate_content','spam',
                                                  'copyright','self_harm_concern','other')),
  context_type    text,                                       -- e.g. nickname, battle, peer_question, document
  context_id      uuid,
  comment         text check (char_length(comment) <= 500),
  status          text not null default 'open' check (status in ('open','actioned','dismissed','escalated')),
  handled_by      uuid references public.profiles(id) on delete set null,
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index user_reports_group_open on public.user_reports (class_group_id) where status = 'open';

-- =====================================================================
-- 5.2 Subjects, documents, knowledge map (supporting tables)
-- =====================================================================
create table public.subject_user_settings (                 -- [sync] PLT-03.2, PLT-03.4 (per user, personal and shared)
  user_id      uuid not null references public.profiles(id) on delete cascade,
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  pinned       boolean not null default false,
  sort_order   int not null default 0,
  archived_at  timestamptz,                                  -- a real archive, never a delete (R3)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, subject_id)
);
create index subject_user_settings_sync on public.subject_user_settings (updated_at, user_id);

create table public.document_slices (                       -- [svc] ING-02, TUT-01 (R14 ephemeral Files API ids)
  id                        uuid primary key default public.uuid_v7(),
  document_id               uuid not null references public.documents(id) on delete cascade,
  purpose                   text not null check (purpose in ('outline','topic','transcription','tutor')),
  page_start                int not null check (page_start >= 1),   -- original page numbers
  page_end                  int not null check (page_end >= page_start),
  storage_path              text not null,
  size_bytes                bigint not null check (size_bytes > 0),
  est_tokens                int not null check (est_tokens >= 0),
  anthropic_file_id         text,
  anthropic_file_expires_at timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (document_id, purpose, page_start, page_end)
);

create table public.node_sources (                          -- [sync] ING-03, TRU-01
  id           uuid primary key default public.uuid_v7(),
  node_id      uuid not null references public.knowledge_nodes(id) on delete cascade,
  document_id  uuid not null references public.documents(id) on delete cascade,
  page_start   int not null check (page_start >= 1),
  page_end     int not null check (page_end >= page_start),
  origin       text not null check (origin in ('ai','user')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (node_id, document_id, page_start, page_end)
);
create index node_sources_document on public.node_sources (document_id);
create index node_sources_sync on public.node_sources (updated_at, id);

create table public.node_prerequisites (                    -- [sync] ING-03, LRN-04
  node_id               uuid not null references public.knowledge_nodes(id) on delete cascade,
  prerequisite_node_id  uuid not null references public.knowledge_nodes(id) on delete cascade,
  origin                text not null check (origin in ('ai','user')),
  confidence            real check (confidence between 0 and 1),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  primary key (node_id, prerequisite_node_id),
  check (node_id <> prerequisite_node_id)                    -- a nightly job rejects cycles
);
create index node_prerequisites_sync on public.node_prerequisites (updated_at, node_id, prerequisite_node_id);

create table public.node_relations (                        -- [sync] LRN-04.1
  id           uuid primary key default public.uuid_v7(),
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  from_node_id uuid not null references public.knowledge_nodes(id) on delete cascade,
  to_node_id   uuid not null references public.knowledge_nodes(id) on delete cascade,
  kind         text not null check (kind in ('related','contrast')),
  reason       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (from_node_id, to_node_id, kind),
  check (from_node_id <> to_node_id)
);
create index node_relations_sync on public.node_relations (subject_id, updated_at, id);

create table public.node_user_settings (                    -- [sync] ING-04.6 (R1)
  user_id     uuid not null references public.profiles(id) on delete cascade,
  node_id     uuid not null references public.knowledge_nodes(id) on delete cascade,
  excluded    boolean not null default false,               -- "Não cai na prova"
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, node_id)
);
create index node_user_settings_sync on public.node_user_settings (updated_at, user_id);

create table public.node_events (                           -- [append] ING-04 audit and undo
  id          uuid primary key default public.uuid_v7(),
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  node_id     uuid not null references public.knowledge_nodes(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null check (action in ('create','rename','reorder','move','merge','split','delete','restore')),
  payload     jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),   -- {before, after}
  undone_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index node_events_subject on public.node_events (subject_id, created_at desc);

-- =====================================================================
-- 5.11 AI operations and platform
-- =====================================================================
create table public.ai_jobs (                                -- [svc] PLT-04, ING, all async features
  id                uuid primary key default public.uuid_v7(),
  type              text not null,                           -- pg-boss job name (api.md §7)
  user_id           uuid references public.profiles(id) on delete set null,   -- requester
  subject_id        uuid references public.subjects(id) on delete cascade,
  document_id      uuid references public.documents(id) on delete cascade,
  parent_job_id     uuid references public.ai_jobs(id) on delete cascade,     -- groups the stages of one ingestion
  stage             text,
  status            text not null default 'queued'
                    check (status in ('queued','running','waiting_batch','waiting_budget','succeeded','failed','cancelled')),
  progress          real not null default 0 check (progress between 0 and 1),
  items_total      int check (items_total >= 0),
  items_done       int check (items_done >= 0),
  batch_id          text,                                    -- Claude Message Batch id
  pgboss_job_id     uuid,
  attempts          int not null default 0,
  error_code        text,
  error_message_key text,                                     -- i18n key, never raw errors
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index ai_jobs_subject on public.ai_jobs (subject_id, created_at desc);
create index ai_jobs_user_status on public.ai_jobs (user_id, status);

create table public.ai_usage (                              -- [append] [svc] PLT-04, retained 24 months
  id                          uuid primary key default public.uuid_v7(),
  user_id                     uuid references public.profiles(id) on delete set null,      -- anonymized on account deletion
  class_group_id              uuid references public.class_groups(id) on delete set null,
  subject_id                  uuid references public.subjects(id) on delete set null,
  job_id                      uuid references public.ai_jobs(id) on delete set null,
  document_id                 uuid references public.documents(id) on delete set null,
  node_id                     uuid references public.knowledge_nodes(id) on delete set null,
  feature                     text not null,                  -- PRD feature ID, e.g. TUT-01
  task                        text not null,                  -- ai-pipeline.md task id, e.g. ing.outline
  model                       text not null,
  fallback_model              text,
  request_id                  text,
  batch                       boolean not null default false,
  effort                      text,
  input_tokens                int not null default 0 check (input_tokens >= 0),
  output_tokens               int not null default 0 check (output_tokens >= 0),
  cache_creation_input_tokens int not null default 0 check (cache_creation_input_tokens >= 0),
  cache_read_input_tokens     int not null default 0 check (cache_read_input_tokens >= 0),
  server_tool_uses            jsonb check (server_tool_uses is null or jsonb_typeof(server_tool_uses) = 'object'),
  cost_micro_usd              bigint not null check (cost_micro_usd >= 0),
  price_version               text not null,
  stop_reason                 text,
  refusal_category            text,
  latency_ms                  int check (latency_ms >= 0),
  prompt_version              text,
  created_at                  timestamptz not null default now()
);
create index ai_usage_user on public.ai_usage (user_id, created_at);
create index ai_usage_class on public.ai_usage (class_group_id, created_at);
create index ai_usage_feature on public.ai_usage (feature, created_at);

create table public.feature_flags (                         -- keys readable only via my_feature_flags()
  key              text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  description      text not null default '',
  enabled_all      boolean not null default false,
  user_ids         uuid[] not null default '{}',
  class_group_ids  uuid[] not null default '{}',
  percentage       smallint not null default 0 check (percentage between 0 and 100),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.app_versions (                          -- mobile-app.md §17
  version_code     int primary key check (version_code > 0),
  version_name     text not null,
  runtime_version  text not null,
  install_url      text,
  released_at      timestamptz not null default now(),
  blocks_older     boolean not null default false,
  notes_ptbr       text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.app_feedback (                          -- PLT-06.5
  id             uuid primary key default public.uuid_v7(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  text           text not null check (char_length(text) between 1 and 2000),
  screenshot_path text,                                      -- photos bucket, feedback/{user_id}/{id}.jpg
  app_version    text,
  device_model   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.release_notes (                         -- PLT-06.6
  version      text primary key,
  published_at timestamptz not null default now(),
  items        jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),  -- PT-BR strings
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.data_exports (                          -- [svc] SP-14, security §10
  id            uuid primary key default public.uuid_v7(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'queued' check (status in ('queued','running','ready','failed','expired')),
  storage_path  text,
  expires_at    timestamptz,                                  -- +7 days
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.account_deletions (                     -- [svc] SP-14, security §10
  id                     uuid primary key default public.uuid_v7(),
  user_id                uuid not null,                     -- plain uuid, no FK: the row outlives the profile
  requested_by           text not null check (requested_by in ('self','guardian')),
  delete_shared_uploads  boolean not null default false,
  status                 text not null default 'pending' check (status in ('pending','running','done','failed')),
  requested_at           timestamptz not null default now(),
  completed_at           timestamptz,                        -- <= 15 days after request
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---- private schema (never exposed through the API) ----

create table private.ai_budgets (                           -- [svc] PLT-04, security §7
  scope_type         text not null check (scope_type in ('user','class_group','global')),
  scope_id           uuid not null,                           -- zero uuid for global
  period_type        text not null check (period_type in ('day','month')),
  period_start       date not null,
  limit_micro_usd    bigint not null check (limit_micro_usd >= 0),
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  spent_micro_usd    bigint not null default 0 check (spent_micro_usd >= 0),
  updated_at         timestamptz not null default now(),
  primary key (scope_type, scope_id, period_type, period_start)
);

create table private.ai_budget_reservations (               -- companion of ai_budgets: crashed calls release their hold
  reservation_id      uuid not null,
  scope_type          text not null,
  scope_id            uuid not null,
  period_type         text not null,
  period_start        date not null,
  amount_micro_usd    bigint not null check (amount_micro_usd >= 0),
  status              text not null default 'reserved' check (status in ('reserved','released','settled')),
  expires_at          timestamptz not null default now() + interval '10 minutes',
  created_at          timestamptz not null default now(),
  settled_at          timestamptz,
  primary key (reservation_id, scope_type, scope_id, period_type, period_start),
  foreign key (scope_type, scope_id, period_type, period_start)
    references private.ai_budgets (scope_type, scope_id, period_type, period_start)
);
create index ai_budget_reservations_open on private.ai_budget_reservations (expires_at) where status = 'reserved';

create table private.idempotency_keys (                     -- [svc] api.md §2.4
  user_id        uuid not null references public.profiles(id) on delete cascade,
  function_name  text not null,
  key            uuid not null,
  request_hash   text not null,
  status_code    int not null check (status_code between 100 and 599),
  response       jsonb,
  created_at     timestamptz not null default now(),
  primary key (user_id, function_name, key)
);
create index idempotency_keys_created on private.idempotency_keys (created_at);

create table private.moderation_actions (                   -- [append] [svc] SP-09, security §12, retained >= 5 years
  id           uuid primary key default public.uuid_v7(),
  actor_id     uuid references public.profiles(id) on delete set null,
  actor_kind   text not null check (actor_kind in ('moderator','owner','app_admin','system')),
  action       text not null check (action in ('hide','remove','restore','ban','unban','remove_member',
                                               'takedown','appeal_upheld','appeal_rejected')),
  target_type  text not null,
  target_id    uuid,
  reason       text,
  flag_id      uuid,                                          -- content_flags (later migration)
  report_id    uuid references public.user_reports(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- =====================================================================
-- Views (data-model §5.1)
-- =====================================================================
-- Display names are shown only when approved; the view's WHERE clause is the access control
-- (it runs as its owner and therefore bypasses RLS on profiles).
create view public.profiles_public with (security_barrier = true) as
  select p.id,
         case when p.display_name_status = 'approved' then p.display_name end as display_name,
         p.avatar_preset,
         p.avatar_path
  from public.profiles p
  where p.deleted_at is null
    and (p.id = auth.uid() or private.shares_class_with(p.id));

create view public.class_group_members_public with (security_barrier = true) as
  select m.class_group_id, m.user_id, m.role, m.nickname,
         case when p.display_name_status = 'approved' then p.display_name end as display_name,
         p.avatar_path
  from public.class_group_members m
  join public.profiles p on p.id = m.user_id
  where m.status = 'active' and private.is_member(m.class_group_id);

-- =====================================================================
-- Triggers
-- =====================================================================
-- Changing a display name sends it back to moderation (SP-11). Only client writes are affected.
create or replace function private.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.display_name is distinct from old.display_name and current_user = 'authenticated' then
    new.display_name_status := 'pending';
  end if;
  return new;
end $$;

create trigger profiles_display_name_guard before update of display_name on public.profiles
  for each row execute function private.profiles_guard();

-- Members may only move their own status to 'left'. Moderation goes through RPC (security definer),
-- for which current_user is the function owner, not 'authenticated'.
create or replace function private.class_group_members_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' and new.status is distinct from old.status and new.status <> 'left' then
    raise exception 'a member may only set their own status to left' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger class_group_members_guard before update of status on public.class_group_members
  for each row execute function private.class_group_members_guard();

-- PLT-05.3: users under 18 need a quiet window of at least 8 hours.
create or replace function private.enforce_minor_quiet_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_birth_year  smallint;
  v_birth_month smallint;
  v_secs        int;
begin
  select p.birth_year, p.birth_month into v_birth_year, v_birth_month
    from public.profiles p where p.id = new.user_id;
  if v_birth_year is null then
    return new;
  end if;
  if extract(year from age(current_date, make_date(v_birth_year, v_birth_month, 1))) < 18 then
    v_secs := mod(extract(epoch from new.quiet_end)::int - extract(epoch from new.quiet_start)::int + 86400, 86400);
    if v_secs < 8 * 3600 then
      raise exception 'quiet hours for users under 18 must last at least 8 hours' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger study_preferences_minor_quiet before insert or update of quiet_start, quiet_end
  on public.study_preferences for each row execute function private.enforce_minor_quiet_hours();

-- Append-only tables (review_logs, ai_usage, moderation actions): no UPDATE or DELETE from any
-- role. The one exception is an account purge (cascade deletes and anonymization), which must
-- set studify.allow_purge = 'on' inside its transaction.
create or replace function private.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('studify.allow_purge', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op using errcode = '42501';
end $$;

create trigger review_logs_append_only before update or delete on public.review_logs
  for each row execute function private.forbid_mutation();
create trigger ai_usage_append_only before update or delete on public.ai_usage
  for each row execute function private.forbid_mutation();
create trigger moderation_actions_append_only before update or delete on private.moderation_actions
  for each row execute function private.forbid_mutation();

-- updated_at maintenance (data-model §1.1) for every table that has the column.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','class_groups','class_group_members','subjects','documents','document_pages',
    'knowledge_nodes','cards','card_states','questions','goals','exams','plan_runs','plan_items',
    'study_preferences','push_tokens','notification_log','user_reports','subject_user_settings',
    'node_sources','node_prerequisites','node_relations','node_user_settings','ai_jobs',
    'feature_flags','app_versions','app_feedback','release_notes','data_exports','account_deletions'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

-- Realtime (data-model §8.1): status and progress the app shows live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.ai_jobs, public.documents, public.class_group_members;
  end if;
end $$;

-- =====================================================================
-- Row Level Security: enable everywhere, grants, policies (data-model §6.2, §6.3)
-- Every table starts with no client access; each block grants only what its policies allow.
-- =====================================================================

-- ---- profiles ----------------------------------------------------------
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_preset, avatar_path, school_year, timezone, foreign_language,
              settings, onboarding_completed_at, privacy_notice_version, privacy_accepted_at)
  on public.profiles to authenticated;
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke all on public.profiles_public from anon, authenticated;
grant select on public.profiles_public to authenticated;
revoke all on public.class_group_members_public from anon, authenticated;
grant select on public.class_group_members_public to authenticated;

-- ---- study_preferences ------------------------------------------------
alter table public.study_preferences enable row level security;
revoke all on public.study_preferences from anon, authenticated;
grant select, insert, update on public.study_preferences to authenticated;
create policy study_preferences_select_own on public.study_preferences for select to authenticated
  using (user_id = auth.uid());
create policy study_preferences_insert_own on public.study_preferences for insert to authenticated
  with check (user_id = auth.uid());
create policy study_preferences_update_own on public.study_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- invites ----------------------------------------------------------
-- Redemption goes through join_class_group (security definer); clients never read a Turma code
-- except the moderators and the creator. Revocation and rotation are RPCs.
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
grant select, insert on public.invites to authenticated;
create policy invites_select on public.invites for select to authenticated
  using (created_by = auth.uid()
         or (class_group_id is not null and private.is_moderator(class_group_id))
         or private.is_app_admin());
create policy invites_insert_pilot on public.invites for insert to authenticated
  with check (private.is_app_admin() and created_by = auth.uid() and class_group_id is null);

-- ---- class_groups -----------------------------------------------------
alter table public.class_groups enable row level security;
revoke all on public.class_groups from anon, authenticated;
grant select on public.class_groups to authenticated;
grant update (name, school, school_year, join_policy, member_cap, allow_member_uploads, settings)
  on public.class_groups to authenticated;   -- ai_budget_monthly_micro_usd is owner-only (RPC, later)
create policy class_groups_select on public.class_groups for select to authenticated
  using (private.is_member(id));
create policy class_groups_update_moderator on public.class_groups for update to authenticated
  using (private.is_moderator(id)) with check (private.is_moderator(id));

-- ---- class_group_members ----------------------------------------------
alter table public.class_group_members enable row level security;
revoke all on public.class_group_members from anon, authenticated;
grant select on public.class_group_members to authenticated;
grant update (nickname, contribute_insights, league_opt_in, accepts_duels, status)
  on public.class_group_members to authenticated;
create policy class_group_members_select on public.class_group_members for select to authenticated
  using (user_id = auth.uid() or private.is_moderator(class_group_id));
create policy class_group_members_update_own on public.class_group_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- subjects ---------------------------------------------------------
alter table public.subjects enable row level security;
revoke all on public.subjects from anon, authenticated;
grant select, insert on public.subjects to authenticated;
grant update (name, color, icon, content_language, is_language_subject, enem_area, deleted_at)
  on public.subjects to authenticated;
create policy subjects_select on public.subjects for select to authenticated
  using (private.can_read_subject(id));
create policy subjects_insert_personal on public.subjects for insert to authenticated
  with check (owner_profile_id = auth.uid() and created_by = auth.uid() and owner_class_group_id is null);
-- Soft delete is an UPDATE of deleted_at; can_edit_subject() is false once deleted, so the
-- check admits the deleting write while the USING clause still requires edit rights on the old row.
create policy subjects_update on public.subjects for update to authenticated
  using (private.can_edit_subject(id))
  with check (deleted_at is not null or private.can_edit_subject(id));

-- ---- subject_user_settings --------------------------------------------
alter table public.subject_user_settings enable row level security;
revoke all on public.subject_user_settings from anon, authenticated;
grant select, insert, update, delete on public.subject_user_settings to authenticated;
create policy subject_user_settings_select_own on public.subject_user_settings for select to authenticated
  using (user_id = auth.uid());
create policy subject_user_settings_insert_own on public.subject_user_settings for insert to authenticated
  with check (user_id = auth.uid() and private.can_read_subject(subject_id));
create policy subject_user_settings_update_own on public.subject_user_settings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.can_read_subject(subject_id));
create policy subject_user_settings_delete_own on public.subject_user_settings for delete to authenticated
  using (user_id = auth.uid());

-- ---- documents --------------------------------------------------------
alter table public.documents enable row level security;
revoke all on public.documents from anon, authenticated;
grant select on public.documents to authenticated;
grant insert (id, subject_id, uploaded_by, title, kind, storage_path, mime_type, size_bytes, checksum_sha256,
              teacher_name, exam_year, exam_term, integrity_confirmed, copyright_ack_at)
  on public.documents to authenticated;
grant update (title, kind, teacher_name, exam_year, exam_term, integrity_confirmed, copyright_ack_at, deleted_at)
  on public.documents to authenticated;   -- status, pages and error codes are written by the worker
create policy documents_select on public.documents for select to authenticated
  using (private.can_read_subject(subject_id));
create policy documents_insert on public.documents for insert to authenticated
  with check (uploaded_by = auth.uid() and status = 'uploaded' and private.can_upload_to_subject(subject_id));
create policy documents_update on public.documents for update to authenticated
  using (private.can_read_subject(subject_id)
         and (private.can_edit_subject(subject_id) or uploaded_by = auth.uid()))
  with check (deleted_at is not null
              or (private.can_read_subject(subject_id)
                  and (private.can_edit_subject(subject_id) or uploaded_by = auth.uid())));

-- ---- document_pages ---------------------------------------------------
alter table public.document_pages enable row level security;
revoke all on public.document_pages from anon, authenticated;
grant select on public.document_pages to authenticated;
create policy document_pages_select on public.document_pages for select to authenticated
  using (private.can_read_document(document_id));

-- ---- document_slices (service only) -----------------------------------
alter table public.document_slices enable row level security;
revoke all on public.document_slices from anon, authenticated;

-- ---- knowledge_nodes (edits only through edit_outline) ----------------
alter table public.knowledge_nodes enable row level security;
revoke all on public.knowledge_nodes from anon, authenticated;
grant select on public.knowledge_nodes to authenticated;
create policy knowledge_nodes_select on public.knowledge_nodes for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- node_sources / node_prerequisites / node_relations ---------------
alter table public.node_sources enable row level security;
revoke all on public.node_sources from anon, authenticated;
grant select on public.node_sources to authenticated;
create policy node_sources_select on public.node_sources for select to authenticated
  using (private.can_read_node(node_id));

alter table public.node_prerequisites enable row level security;
revoke all on public.node_prerequisites from anon, authenticated;
grant select on public.node_prerequisites to authenticated;
create policy node_prerequisites_select on public.node_prerequisites for select to authenticated
  using (private.can_read_node(node_id));

alter table public.node_relations enable row level security;
revoke all on public.node_relations from anon, authenticated;
grant select on public.node_relations to authenticated;
create policy node_relations_select on public.node_relations for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- node_user_settings (per user) ------------------------------------
alter table public.node_user_settings enable row level security;
revoke all on public.node_user_settings from anon, authenticated;
grant select, insert, update, delete on public.node_user_settings to authenticated;
create policy node_user_settings_select_own on public.node_user_settings for select to authenticated
  using (user_id = auth.uid());
create policy node_user_settings_insert_own on public.node_user_settings for insert to authenticated
  with check (user_id = auth.uid() and private.can_read_node(node_id));
create policy node_user_settings_update_own on public.node_user_settings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.can_read_node(node_id));
create policy node_user_settings_delete_own on public.node_user_settings for delete to authenticated
  using (user_id = auth.uid());

-- ---- node_events (written by RPCs only) -------------------------------
alter table public.node_events enable row level security;
revoke all on public.node_events from anon, authenticated;
grant select on public.node_events to authenticated;
create policy node_events_select on public.node_events for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- cards ------------------------------------------------------------
alter table public.cards enable row level security;
revoke all on public.cards from anon, authenticated;
grant select on public.cards to authenticated;
grant insert (id, subject_id, node_id, concept_id, type, front, back, media, has_math, sibling_group_id,
              cloze_index, source_pages, origin, created_by, personal_for_user_id)
  on public.cards to authenticated;
grant update (front, back, media, has_math, status, concept_id, deleted_at) on public.cards to authenticated;
create policy cards_select on public.cards for select to authenticated
  using (private.can_read_item(subject_id, personal_for_user_id));
create policy cards_insert_user on public.cards for insert to authenticated
  with check (origin in ('user','from_mistake','from_tutor') and created_by = auth.uid()
              and private.can_read_subject(subject_id)
              and (personal_for_user_id = auth.uid() or private.can_edit_subject(subject_id)));
-- Shared-subject fixes go through TRU-02 (resolve_flag), so only personal items and personal subjects are editable here.
create policy cards_update on public.cards for update to authenticated
  using (private.can_read_subject(subject_id)
         and (personal_for_user_id = auth.uid()
              or (private.can_edit_subject(subject_id) and private.owns_personal_subject(subject_id))))
  with check (private.can_read_subject(subject_id)
              and (personal_for_user_id = auth.uid()
                   or (private.can_edit_subject(subject_id) and private.owns_personal_subject(subject_id))));

-- ---- card_states (written by sync-push replay only) -------------------
alter table public.card_states enable row level security;
revoke all on public.card_states from anon, authenticated;
grant select on public.card_states to authenticated;
create policy card_states_select_own on public.card_states for select to authenticated
  using (user_id = auth.uid());

-- ---- review_logs (append-only, inserted only by sync-push) ------------
alter table public.review_logs enable row level security;
revoke all on public.review_logs from anon, authenticated;
grant select on public.review_logs to authenticated;
create policy review_logs_select_own on public.review_logs for select to authenticated
  using (user_id = auth.uid());

-- ---- questions --------------------------------------------------------
alter table public.questions enable row level security;
revoke all on public.questions from anon, authenticated;
grant select on public.questions to authenticated;
grant insert (id, subject_id, node_id, concept_ids, type, stem, stimulus, texto_base, payload, explanation,
              bloom_level, difficulty, has_math, fixed_order, format_features, origin, author_id,
              author_anonymous, personal_for_user_id, review_status, rationale)
  on public.questions to authenticated;
grant update (node_id, concept_ids, stem, stimulus, texto_base, payload, explanation, bloom_level, difficulty,
              format_features, status, deleted_at)
  on public.questions to authenticated;
create policy questions_select on public.questions for select to authenticated
  using (private.can_read_item(subject_id, personal_for_user_id)
         and (review_status = 'approved'
              or author_id = auth.uid()
              or exists (select 1 from public.subjects s
                         where s.id = subject_id and s.owner_class_group_id is not null
                           and private.is_moderator(s.owner_class_group_id))));
-- User questions are personal by default (R8); peer questions enter as 'pending' (SOC-07).
create policy questions_insert_user on public.questions for insert to authenticated
  with check (author_id = auth.uid()
              and private.can_read_subject(subject_id)
              and ((origin = 'user' and review_status = 'approved')
                   or (origin = 'peer' and review_status = 'pending'))
              and (personal_for_user_id = auth.uid() or private.can_edit_subject(subject_id) or origin = 'peer'));
create policy questions_update on public.questions for update to authenticated
  using (private.can_read_subject(subject_id)
         and (personal_for_user_id = auth.uid()
              or (private.can_edit_subject(subject_id) and private.owns_personal_subject(subject_id))))
  with check (private.can_read_subject(subject_id)
              and (personal_for_user_id = auth.uid()
                   or (private.can_edit_subject(subject_id) and private.owns_personal_subject(subject_id))));

-- ---- goals ------------------------------------------------------------
alter table public.goals enable row level security;
revoke all on public.goals from anon, authenticated;
grant select, insert, update on public.goals to authenticated;
create policy goals_select_own on public.goals for select to authenticated
  using (user_id = auth.uid());
create policy goals_insert_own on public.goals for insert to authenticated
  with check (user_id = auth.uid());
create policy goals_update_own on public.goals for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- exams ------------------------------------------------------------
-- scope_status is set by confirm_exam_scope (later migration), never directly.
alter table public.exams enable row level security;
revoke all on public.exams from anon, authenticated;
grant select, insert on public.exams to authenticated;
grant update (subject_id, title, local_date, starts_at, duration_min, kind, status, parent_exam_id,
              teacher_name, weight, grade, grade_max, deleted_at)
  on public.exams to authenticated;
create policy exams_select_own on public.exams for select to authenticated
  using (user_id = auth.uid());
create policy exams_insert_own on public.exams for insert to authenticated
  with check (user_id = auth.uid()
              and goal_id in (select g.id from public.goals g where g.user_id = auth.uid())
              and (subject_id is null or private.can_read_subject(subject_id)));
create policy exams_update_own on public.exams for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and goal_id in (select g.id from public.goals g where g.user_id = auth.uid())
              and (subject_id is null or private.can_read_subject(subject_id)));

-- ---- plan_runs (planner writes only) ----------------------------------
alter table public.plan_runs enable row level security;
revoke all on public.plan_runs from anon, authenticated;
grant select on public.plan_runs to authenticated;
create policy plan_runs_select_own on public.plan_runs for select to authenticated
  using (user_id = auth.uid());

-- ---- plan_items -------------------------------------------------------
alter table public.plan_items enable row level security;
revoke all on public.plan_items from anon, authenticated;
grant select, insert on public.plan_items to authenticated;
grant update (status, pinned) on public.plan_items to authenticated;
create policy plan_items_select_own on public.plan_items for select to authenticated
  using (user_id = auth.uid());
create policy plan_items_insert_own on public.plan_items for insert to authenticated
  with check (user_id = auth.uid()
              and plan_run_id in (select r.id from public.plan_runs r where r.user_id = auth.uid())
              and (goal_id is null or goal_id in (select g.id from public.goals g where g.user_id = auth.uid()))
              and (subject_id is null or private.can_read_subject(subject_id)));
create policy plan_items_update_own on public.plan_items for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- user_blocks ------------------------------------------------------
alter table public.user_blocks enable row level security;
revoke all on public.user_blocks from anon, authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
create policy user_blocks_select_own on public.user_blocks for select to authenticated
  using (blocker_id = auth.uid());
create policy user_blocks_insert_own on public.user_blocks for insert to authenticated
  with check (blocker_id = auth.uid());
create policy user_blocks_delete_own on public.user_blocks for delete to authenticated
  using (blocker_id = auth.uid());

-- ---- user_reports -----------------------------------------------------
alter table public.user_reports enable row level security;
revoke all on public.user_reports from anon, authenticated;
grant select, insert on public.user_reports to authenticated;
create policy user_reports_select on public.user_reports for select to authenticated
  using (reporter_id = auth.uid()
         or (class_group_id is not null and private.is_moderator(class_group_id))
         or private.is_app_admin());
create policy user_reports_insert_member on public.user_reports for insert to authenticated
  with check (reporter_id = auth.uid() and class_group_id is not null and private.is_member(class_group_id));

-- ---- push_tokens ------------------------------------------------------
alter table public.push_tokens enable row level security;
revoke all on public.push_tokens from anon, authenticated;
grant select, insert, update, delete on public.push_tokens to authenticated;
create policy push_tokens_select_own on public.push_tokens for select to authenticated
  using (user_id = auth.uid());
create policy push_tokens_insert_own on public.push_tokens for insert to authenticated
  with check (user_id = auth.uid());
create policy push_tokens_update_own on public.push_tokens for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_tokens_delete_own on public.push_tokens for delete to authenticated
  using (user_id = auth.uid());

-- ---- notification_log (worker writes) ---------------------------------
alter table public.notification_log enable row level security;
revoke all on public.notification_log from anon, authenticated;
grant select on public.notification_log to authenticated;
create policy notification_log_select_own on public.notification_log for select to authenticated
  using (user_id = auth.uid());

-- ---- ai_jobs ----------------------------------------------------------
alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from anon, authenticated;
grant select on public.ai_jobs to authenticated;
create policy ai_jobs_select on public.ai_jobs for select to authenticated
  using (user_id = auth.uid() or (subject_id is not null and private.can_read_subject(subject_id)));

-- ---- ai_usage (append-only; totals through class_group_ai_usage RPC) --
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant select on public.ai_usage to authenticated;
create policy ai_usage_select_own on public.ai_usage for select to authenticated
  using (user_id = auth.uid());

-- ---- feature_flags (keys only, via my_feature_flags) ------------------
alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from anon, authenticated;

-- ---- app_versions / release_notes (readable by any signed-in user) ----
alter table public.app_versions enable row level security;
revoke all on public.app_versions from anon, authenticated;
grant select on public.app_versions to authenticated;
create policy app_versions_select on public.app_versions for select to authenticated using (true);

alter table public.release_notes enable row level security;
revoke all on public.release_notes from anon, authenticated;
grant select on public.release_notes to authenticated;
create policy release_notes_select on public.release_notes for select to authenticated using (true);

-- ---- app_feedback -----------------------------------------------------
alter table public.app_feedback enable row level security;
revoke all on public.app_feedback from anon, authenticated;
grant select, insert on public.app_feedback to authenticated;
create policy app_feedback_insert_own on public.app_feedback for insert to authenticated
  with check (user_id = auth.uid());
create policy app_feedback_select_admin on public.app_feedback for select to authenticated
  using (private.is_app_admin());

-- ---- data_exports / account_deletions (Edge Functions write) ----------
alter table public.data_exports enable row level security;
revoke all on public.data_exports from anon, authenticated;
grant select on public.data_exports to authenticated;
create policy data_exports_select_own on public.data_exports for select to authenticated
  using (user_id = auth.uid());

alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from anon, authenticated;
grant select on public.account_deletions to authenticated;
create policy account_deletions_select_own on public.account_deletions for select to authenticated
  using (user_id = auth.uid());

-- ---- private schema: RLS on, no client policies, service role only ----
alter table private.ai_budgets enable row level security;
alter table private.ai_budget_reservations enable row level security;
alter table private.idempotency_keys enable row level security;
alter table private.moderation_actions enable row level security;
revoke all on private.ai_budgets, private.ai_budget_reservations, private.idempotency_keys,
             private.moderation_actions from public, anon, authenticated;
grant all on private.ai_budgets, private.ai_budget_reservations, private.idempotency_keys,
             private.moderation_actions to service_role;
