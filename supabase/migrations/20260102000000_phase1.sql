-- Phase 1 tables not created by the foundation (data-model.md §5.3-§5.7, §10 phase 1):
-- content items, per-user learning state, goal scope and planning, tutor, content flags.
-- Conventions as in 20260101000100_core.sql: text + CHECK enums, UUID v7 ids, deleted_at tombstones on
-- [sync] tables, [append] tables without updated_at and with forbid_mutation, RLS on every table.
-- Grants follow the matrix in data-model.md §6.2; writes the matrix gives to the service role or to
-- RPCs have no client grant. RPCs are in 20260102000100_phase1_rpc.sql.

-- =====================================================================
-- Content flags (TRU-02) and R19 item types (referenced by item_revisions and item_hides)
-- =====================================================================
create table public.content_flags (                       -- TRU-02
  id              uuid primary key default public.uuid_v7(),
  item_type       text not null check (item_type in ('knowledge_node','note','glossary_term','card','question',
                                                     'explanation','feed_item','podcast_episode','tutor_message',
                                                     'visual','document')),
  item_id         uuid not null,
  item_version    int not null check (item_version >= 1),
  class_group_id  uuid references public.class_groups(id) on delete cascade,  -- null for personal items
  reporter_id     uuid not null references public.profiles(id) on delete cascade,
  reason          text not null check (reason in ('wrong_answer','wrong_fact','wrong_page','unclear',
                                                  'inappropriate','copyright','other')),
  comment         text check (char_length(comment) <= 1000),
  ai_verdict      text check (ai_verdict in ('confirmed','rejected','unsure')),
  ai_confidence   text check (ai_confidence in ('low','medium','high')),
  ai_explanation  text,
  ai_source_pages jsonb check (ai_source_pages is null or jsonb_typeof(ai_source_pages) = 'array'),
  ai_proposed_fix jsonb check (ai_proposed_fix is null or jsonb_typeof(ai_proposed_fix) = 'object'),
  status          text not null default 'open'
                  check (status in ('open','triaged','hidden_pending','accepted','rejected','removed','superseded')),
  resolved_by     uuid references public.profiles(id) on delete set null,
  resolved_at     timestamptz,
  reporter_weight real not null default 1 check (reporter_weight >= 0),   -- down-weights serial false reporters
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index content_flags_open_once on public.content_flags (item_type, item_id, reporter_id)
  where status in ('open','triaged','hidden_pending');
create index content_flags_group_open on public.content_flags (class_group_id)
  where status in ('open','triaged','hidden_pending');

-- =====================================================================
-- 5.3 Content items
-- =====================================================================
create table public.notes (                               -- [sync] LRN-01, SOC-06.4
  id                    uuid primary key default public.uuid_v7(),
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  node_id               uuid references public.knowledge_nodes(id) on delete cascade,  -- null only for subject_overview
  scope_kind            text not null default 'topic' check (scope_kind in ('topic','subject_overview')),
  depth                 text not null check (depth in ('tldr','study','deep','class_summary')),
  body                  text not null default '',
  citations             jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  language              text not null,
  word_count            int not null default 0 check (word_count >= 0),
  has_math              boolean not null default false,
  status                text not null default 'pending'
                        check (status in ('pending','generating','ready','failed','superseded')),   -- R4
  supersedes_note_id    uuid references public.notes(id) on delete set null,
  low_citation_coverage boolean not null default false,
  contributors          uuid[] not null default '{}',
  created_by            uuid not null references public.profiles(id),
  version               int not null default 1 check (version >= 1),
  prompt_version        text,
  gen_batch_id          uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  check (node_id is not null or scope_kind = 'subject_overview')
);
create unique index notes_one_current_per_depth on public.notes (node_id, depth)
  where status in ('pending','generating','ready') and deleted_at is null;
create index notes_subject on public.notes (subject_id) where deleted_at is null;
create index notes_sync on public.notes (updated_at, id);

create table public.note_highlights (                     -- [sync] LRN-01.10
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  note_id     uuid not null references public.notes(id) on delete cascade,
  "start"     int not null check ("start" >= 0),
  "end"       int not null check ("end" >= "start"),
  quote       text not null default '',
  color       text not null check (color in ('yellow','green','blue','pink')),
  orphaned    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index note_highlights_sync on public.note_highlights (updated_at, id);
create index note_highlights_note on public.note_highlights (note_id) where deleted_at is null;

create table public.topic_reads (                         -- [append] LRN-01.11
  id          uuid primary key,                           -- client-generated UUID v7
  user_id     uuid not null references public.profiles(id) on delete cascade,
  node_id     uuid not null references public.knowledge_nodes(id) on delete cascade,
  depth       text not null check (depth in ('tldr','study','deep','class_summary')),
  read_at     timestamptz not null,
  seconds     int not null check (seconds >= 0),
  created_at  timestamptz not null default now()
);
create index topic_reads_user_node on public.topic_reads (user_id, node_id, read_at);

create table public.glossary_terms (                      -- [sync] LRN-02
  id               uuid primary key default public.uuid_v7(),
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  node_id          uuid references public.knowledge_nodes(id) on delete set null,
  term             text not null check (char_length(term) between 1 and 120),
  normalized_term  text generated always as (lower(private.f_unaccent(term))) stored,
  aliases          text[] not null default '{}',
  definition       text,
  example          text,
  source_pages     jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  version          int not null default 1 check (version >= 1),
  hidden_reason    text check (hidden_reason in ('under_review','removed')),   -- TRU-02
  prompt_version   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create unique index glossary_terms_normalized on public.glossary_terms (subject_id, normalized_term)
  where deleted_at is null;
create index glossary_terms_sync on public.glossary_terms (updated_at, id);

create table public.glossary_term_overrides (             -- [sync] LRN-02.7
  user_id     uuid not null references public.profiles(id) on delete cascade,
  term_id     uuid not null references public.glossary_terms(id) on delete cascade,
  definition  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, term_id)
);
create index glossary_term_overrides_sync on public.glossary_term_overrides (updated_at, user_id);

create table public.explanations (                        -- LRN-03 (written by the service only)
  id                    uuid primary key default public.uuid_v7(),
  subject_id            uuid not null references public.subjects(id) on delete cascade,
  target_type           text not null check (target_type in ('note_paragraph','concept','glossary_term',
                                                             'question_explanation','card_back')),
  target_id             uuid not null,
  paragraph_index       int check (paragraph_index >= 0),
  style                 text not null check (style in ('simpler','analogy','example','step_by_step')),
  language              text not null,
  body                  text not null,
  citations             jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  personal_for_user_id  uuid references public.profiles(id) on delete cascade,   -- R8; null = shared cache
  saved                 boolean not null default false,
  prompt_version        text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create unique index explanations_shared_cache on public.explanations
  (target_type, target_id, coalesce(paragraph_index, -1), style, language, prompt_version)
  where personal_for_user_id is null and deleted_at is null;
create index explanations_subject on public.explanations (subject_id) where deleted_at is null;

create table public.explanation_feedback (                -- [append] LRN-03.4
  id              uuid primary key,                         -- client-generated
  user_id         uuid not null references public.profiles(id) on delete cascade,
  explanation_id  uuid not null references public.explanations(id) on delete cascade,
  helpful         boolean not null,
  created_at      timestamptz not null default now()
);

create table public.card_overrides (                      -- [sync] MEM-01, architecture §3.2 rule 3
  user_id     uuid not null references public.profiles(id) on delete cascade,
  card_id     uuid not null references public.cards(id) on delete cascade,
  front       text,
  back        text,
  media       jsonb check (media is null or jsonb_typeof(media) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, card_id)
);
create index card_overrides_sync on public.card_overrides (updated_at, user_id);

create table public.concept_contrasts (                   -- PRA-04 ("X vs Y" drills)
  id            uuid primary key default public.uuid_v7(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  concept_a_id  uuid not null references public.knowledge_nodes(id) on delete cascade,
  concept_b_id  uuid not null references public.knowledge_nodes(id) on delete cascade,
  content       jsonb not null check (jsonb_typeof(content) = 'object'),
  source_pages  jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (concept_a_id < concept_b_id),
  unique (concept_a_id, concept_b_id)
);

create table public.item_revisions (                      -- [append] TRU-02.9
  id              uuid primary key default public.uuid_v7(),
  item_type       text not null check (item_type in ('knowledge_node','note','glossary_term','card','question',
                                                     'explanation','feed_item','podcast_episode','tutor_message',
                                                     'visual','document')),
  item_id         uuid not null,
  version         int not null check (version >= 1),
  content         jsonb not null check (jsonb_typeof(content) = 'object'),   -- full snapshot
  changed_by      uuid references public.profiles(id) on delete set null,
  flag_id         uuid references public.content_flags(id) on delete set null,
  answer_changed  boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (item_type, item_id, version)
);

create table public.item_hides (                          -- [sync] TRU-02.3/.5 (R7): never 'card'
  user_id     uuid not null references public.profiles(id) on delete cascade,
  item_type   text not null check (item_type in ('knowledge_node','note','glossary_term','question','explanation',
                                                 'feed_item','podcast_episode','tutor_message','visual','document')),
  item_id     uuid not null,
  reason      text not null check (reason in ('not_useful','wrong','duplicate','other')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, item_type, item_id)
);
create index item_hides_sync on public.item_hides (updated_at, user_id);

-- =====================================================================
-- 5.4 Per-user learning state
-- =====================================================================
create table public.mastery (                             -- [svc] [sync: pull only] MEM-05, GOL-08, TUT-05, PRA
  user_id           uuid not null references public.profiles(id) on delete cascade,
  node_id           uuid not null references public.knowledge_nodes(id) on delete cascade,
  subject_id        uuid not null references public.subjects(id) on delete cascade,
  mastery           real not null check (mastery between 0 and 1),
  retrievability    real check (retrievability between 0 and 1),
  evidence_count    int not null default 0 check (evidence_count >= 0),
  last_evidence_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, node_id)
);
create index mastery_sync on public.mastery (updated_at, user_id);

create table public.mastery_evidence (                    -- [append] [svc] R13
  id           uuid primary key default public.uuid_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  node_id      uuid not null references public.knowledge_nodes(id) on delete cascade,   -- concept when known
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  source       text not null check (source in ('quiz_answer','review','tutor_quiz','feed_question','duel','battle',
                                               'teaching','boss','simulado','diagnostic')),
  outcome      real not null check (outcome between 0 and 1),
  weight       real not null check (weight >= 0),
  ref_type     text not null,
  ref_id       uuid not null,
  occurred_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (ref_type, ref_id, node_id)
);
create index mastery_evidence_user_node on public.mastery_evidence (user_id, node_id, occurred_at);

create table public.essays (                              -- [sync] PRA-07, ENM-05, CAM-03, INT-03 (R5)
  id                     uuid primary key default public.uuid_v7(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  kind                   text not null check (kind in ('enem_redacao','school_answer')),
  theme_id               uuid,                              -- essay_themes (Phase 4): FK added with that migration
  question_id            uuid references public.questions(id) on delete set null,
  text                   text not null default '',
  input_mode             text not null default 'typed' check (input_mode in ('typed','photo')),
  image_paths            text[] not null default '{}',
  capture_id             uuid,                              -- camera_captures (Phase 3): FK added with that migration
  transcription_original text,
  edited_ratio           real check (edited_ratio between 0 and 1),
  line_count             int check (line_count >= 0),
  est_handwritten_lines  int check (est_handwritten_lines >= 0),
  status                 text not null default 'draft' check (status in ('draft','grading','graded','failed')),
  total                  int check (total between 0 and 1000),   -- ENEM 0-1000
  is_zero                boolean,
  zero_reasons           text[],
  competencias           jsonb check (competencias is null or jsonb_typeof(competencias) = 'object'),
  proposta               jsonb,
  repertorio             jsonb,
  rewrites               jsonb,
  grading_runs           jsonb,
  feedback               jsonb,
  version                int not null default 1 check (version >= 1),
  parent_essay_id        uuid references public.essays(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create index essays_sync on public.essays (updated_at, id);

create table public.quizzes (                             -- [sync] PRA-01, PRA-03, FED-01, SOC-02/03, ENM-04, PRA-09, MOT-02
  id               uuid primary key default public.uuid_v7(),
  owner_id         uuid not null references public.profiles(id) on delete cascade,
  subject_id       uuid references public.subjects(id) on delete cascade,
  goal_id          uuid references public.goals(id) on delete cascade,
  exam_id          uuid references public.exams(id) on delete set null,
  class_group_id   uuid references public.class_groups(id) on delete cascade,
  kind             text not null check (kind in ('practice','mock_exam','mistake_retry','feed','predicted_test',
                                                 'boss','duel','battle','enem_simulado')),
  -- 'diagnostic' is the GOL-12.3 mode (data-model §5.5 uses it on a practice quiz).
  mode             text not null default 'practice' check (mode in ('practice','exam_conditions','relaxed','diagnostic')),
  title            text,
  question_ids     uuid[] not null default '{}',
  time_limit_s     int check (time_limit_s > 0),
  scope            jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  config           jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  seed             bigint not null default floor(random() * 2147483647)::bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index quizzes_sync on public.quizzes (updated_at, id);

create table public.quiz_attempts (                       -- [sync] PRA-03, ENM-04
  id             uuid primary key,                         -- client-generated (idempotent sync)
  user_id        uuid not null references public.profiles(id) on delete cascade,
  quiz_id        uuid not null references public.quizzes(id) on delete cascade,
  status         text not null default 'in_progress'
                 check (status in ('in_progress','submitted','expired','abandoned')),
  started_at     timestamptz not null,
  finished_at    timestamptz,
  paused_seconds int not null default 0 check (paused_seconds >= 0),
  device_id      text not null,                             -- one device per attempt (05 §9)
  score          real check (score between 0 and 1),
  grade          numeric,                                   -- on the goal's grading scale
  area_results   jsonb check (area_results is null or jsonb_typeof(area_results) = 'object'),   -- R12
  essay_id       uuid references public.essays(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index quiz_attempts_user_quiz on public.quiz_attempts (user_id, quiz_id);
create index quiz_attempts_sync on public.quiz_attempts (updated_at, id);

create table public.attempt_answers (                     -- [sync] PRA-01…08, CAM-02.10
  id                uuid primary key,                       -- client-generated (idempotent sync)
  attempt_id        uuid not null references public.quiz_attempts(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  question_id       uuid not null references public.questions(id) on delete cascade,
  question_version  int not null check (question_version >= 1),
  response          jsonb,                                  -- null = blank
  correct           boolean,                                -- null while pending AI grading
  score             real check (score between 0 and 1),
  points_awarded    numeric,
  points_max        numeric,
  grading_status    text not null default 'graded' check (grading_status in ('graded','pending','failed','self_graded')),
  grader_confidence text check (grader_confidence in ('high','medium','low')),
  ai_feedback       jsonb check (ai_feedback is null or jsonb_typeof(ai_feedback) = 'object'),
  confidence        smallint check (confidence between 1 and 4),   -- PRA-05
  time_spent_ms    int not null default 0 check (time_spent_ms >= 0),
  hints_used        int not null default 0 check (hints_used >= 0),
  solution_viewed   boolean not null default false,
  marked_for_review boolean not null default false,
  self_override     boolean not null default false,
  typo_tolerated    boolean not null default false,
  assisted          boolean not null default false,
  input_mode        text not null default 'typed' check (input_mode in ('typed','photo')),
  essay_id          uuid references public.essays(id) on delete set null,
  answered_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (attempt_id, question_id)
);
create index attempt_answers_user on public.attempt_answers (user_id, question_id);
create index attempt_answers_sync on public.attempt_answers (updated_at, id);

create table public.mistakes (                            -- [sync] PRA-04 (Caderno de Erros)
  id                  uuid primary key default public.uuid_v7(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  question_id         uuid not null references public.questions(id) on delete cascade,
  attempt_answer_id   uuid not null references public.attempt_answers(id) on delete cascade,
  subject_id          uuid not null references public.subjects(id) on delete cascade,
  node_id             uuid not null references public.knowledge_nodes(id) on delete cascade,
  cause               text not null check (cause in ('didnt_know','confused','careless','misread')),        -- R16
  suggested_cause     text not null check (suggested_cause in ('didnt_know','confused','careless','misread')),
  cause_source        text not null default 'suggested' check (cause_source in ('suggested','user')),
  user_note           text check (char_length(user_note) <= 2000),
  next_retry_at       date not null default current_date,
  retry_step          smallint not null default 0 check (retry_step between 0 and 2),   -- +1/+3/+7 days
  success_days        smallint not null default 0 check (success_days >= 0),
  remediation_card_id uuid references public.cards(id) on delete set null,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index mistakes_one_open_per_question on public.mistakes (user_id, question_id)
  where resolved_at is null and deleted_at is null;
create index mistakes_sync on public.mistakes (updated_at, id);

-- PRA-05 calibration. Own rows only through security_invoker (RLS of attempt_answers and questions applies).
create view public.calibration_stats with (security_invoker = true) as
  select aa.user_id, q.node_id, aa.confidence,
         count(*) as n,
         count(*) filter (where aa.correct) as n_correct
    from public.attempt_answers aa
    join public.questions q on q.id = aa.question_id
   where aa.confidence is not null and aa.correct is not null and not aa.self_override
     and aa.deleted_at is null
   group by 1, 2, 3;

-- =====================================================================
-- 5.5 Goals: scope, grading, study sessions, desperate mode, predictions
-- =====================================================================
create table public.exam_scope_items (                    -- [sync] GOL-03
  id                  uuid primary key default public.uuid_v7(),
  exam_id             uuid not null references public.exams(id) on delete cascade,
  raw_text            text not null check (char_length(raw_text) between 1 and 500),
  position            int not null default 0 check (position >= 0),
  status              text not null default 'unmatched' check (status in ('matched','partial','unmatched')),
  placeholder_node_id uuid references public.knowledge_nodes(id) on delete set null,
  source_document_id  uuid references public.documents(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index exam_scope_items_sync on public.exam_scope_items (updated_at, id);
create index exam_scope_items_exam on public.exam_scope_items (exam_id) where deleted_at is null;

create table public.exam_scope_nodes (                    -- [sync] GOL-03 (R2)
  exam_id        uuid not null references public.exams(id) on delete cascade,
  node_id        uuid not null references public.knowledge_nodes(id) on delete cascade,
  scope_item_id  uuid references public.exam_scope_items(id) on delete set null,
  source         text not null check (source in ('ai','user','default_all')),
  confidence     real check (confidence between 0 and 1),
  confirmed      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (exam_id, node_id)
);
create index exam_scope_nodes_sync on public.exam_scope_nodes (updated_at, exam_id, node_id);

create table public.grading_rules (                       -- [sync] GOL-06 (R15)
  id                      uuid primary key default public.uuid_v7(),
  owner_profile_id        uuid not null references public.profiles(id) on delete cascade,
  subject_id              uuid references public.subjects(id) on delete cascade,   -- null = school default
  school_year             smallint not null,
  formula                 jsonb not null check (jsonb_typeof(formula) = 'object'),  -- GradingFormula, spec 07 §8.5.1
  preset_key              text,
  template_class_group_id uuid references public.class_groups(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
create unique index grading_rules_owner_year_subject on public.grading_rules
  (owner_profile_id, school_year, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null;
create index grading_rules_sync on public.grading_rules (updated_at, id);

create table public.grade_components (                    -- [sync] GOL-06.2
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  school_year smallint not null,
  term_index  smallint not null check (term_index between 1 and 4),
  name        text not null check (char_length(name) between 1 and 80),
  kind        text not null check (kind in ('exam','assignment','other')),
  weight      numeric check (weight > 0),
  max_points  numeric check (max_points > 0),
  grade       numeric check (grade >= 0),
  exam_id     uuid references public.exams(id) on delete set null,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index grade_components_term on public.grade_components (user_id, subject_id, school_year, term_index)
  where deleted_at is null;
create index grade_components_sync on public.grade_components (updated_at, id);

create table public.study_sessions (                      -- [sync] GOL-05, FED-01, WEL-01/02, MOT-01 (R17)
  id                    uuid primary key,                   -- client-generated
  user_id               uuid not null references public.profiles(id) on delete cascade,
  kind                  text not null check (kind in ('mixed','review','practice','simulado','feed','focus',
                                                      'vespera','tutor','teaching','podcast')),
  plan_item_id          uuid references public.plan_items(id) on delete set null,
  goal_id               uuid references public.goals(id) on delete set null,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  active_minutes        int not null default 0 check (active_minutes >= 0),
  activities            jsonb not null default '[]'::jsonb check (jsonb_typeof(activities) = 'array'),
  planned_focus_minutes int check (planned_focus_minutes >= 0),
  cycles_planned        int check (cycles_planned >= 0),
  cycles_done           int check (cycles_done >= 0),
  interruptions         int check (interruptions >= 0),
  blocked_attempts      int check (blocked_attempts >= 0),
  dnd_used              boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index study_sessions_sync on public.study_sessions (updated_at, id);
create index study_sessions_user_start on public.study_sessions (user_id, started_at);

-- plan_items.completed_session_id was left without a target table by the core migration.
alter table public.plan_items add constraint plan_items_completed_session_fkey
  foreign key (completed_session_id) references public.study_sessions(id) on delete set null;

create table public.availability_exceptions (             -- [sync] GOL-04.3, GOL-09.2
  user_id     uuid not null references public.profiles(id) on delete cascade,
  local_date  date not null,
  minutes     int not null check (minutes >= 0),          -- 0 = blocked
  source      text not null check (source in ('user','calendar','desperate')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, local_date)
);
create index availability_exceptions_sync on public.availability_exceptions (updated_at, user_id);

create table public.desperate_modes (                     -- [sync] GOL-12
  id                     uuid primary key default public.uuid_v7(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  goal_id                uuid not null references public.goals(id) on delete cascade,
  status                 text not null default 'active' check (status in ('active','ended','cancelled')),
  exam_ids               uuid[] not null default '{}' check (cardinality(exam_ids) >= 1),
  minutes_per_day        int not null check (minutes_per_day between 60 and 240),
  topic_groups           jsonb not null default '{}'::jsonb check (jsonb_typeof(topic_groups) = 'object'),
  user_moves             jsonb not null default '[]'::jsonb check (jsonb_typeof(user_moves) = 'array'),
  diagnostic_attempt_id  uuid references public.quiz_attempts(id) on delete set null,
  started_at             timestamptz not null default now(),
  ended_at               timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create unique index desperate_modes_one_active on public.desperate_modes (user_id, goal_id)
  where status = 'active' and deleted_at is null;
create index desperate_modes_sync on public.desperate_modes (updated_at, id);

create table public.readiness_snapshots (                 -- [svc] GOL-08, GOL-11
  user_id         uuid not null references public.profiles(id) on delete cascade,
  exam_id         uuid not null references public.exams(id) on delete cascade,
  local_date      date not null,
  readiness       real not null,
  readiness_proj  real,
  pred_low        numeric,
  pred_mid        numeric,
  pred_high       numeric,
  evidence        jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, exam_id, local_date)
);

create table public.teacher_profiles (                    -- [svc] PRA-09.4 (R22: teacher_key normalizes teacher_name)
  id                  uuid primary key default public.uuid_v7(),
  subject_id          uuid not null references public.subjects(id) on delete cascade,
  teacher_key         text,
  teacher_display     text not null,
  source_document_ids uuid[] not null default '{}',
  n_tests             int not null default 0 check (n_tests >= 0),
  profile             jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object'),
  confidence          text not null check (confidence in ('low','mid','high')),
  computed_at         timestamptz not null default now(),
  version             int not null default 1 check (version >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index teacher_profiles_key on public.teacher_profiles (subject_id, coalesce(teacher_key, ''));

create table public.topic_predictions (                   -- [svc] PRA-09.6, ENM-08.3
  id                  uuid primary key default public.uuid_v7(),
  target_type         text not null check (target_type in ('exam','enem_goal')),
  target_id           uuid not null,
  node_id             uuid references public.knowledge_nodes(id) on delete cascade,   -- school
  enem_topic_id       uuid,                                  -- enem_topics (Phase 4): FK added with that migration
  weight              real not null,
  base_weight         real,
  evidence            jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  teacher_profile_id  uuid references public.teacher_profiles(id) on delete set null,
  computed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((node_id is null) <> (enem_topic_id is null))   -- exactly one of the two
);
create index topic_predictions_target on public.topic_predictions (target_type, target_id);

create table public.exam_outcome_topics (                 -- PRA-09.11 ("O que caiu?")
  exam_id     uuid not null references public.exams(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  node_id     uuid not null references public.knowledge_nodes(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (exam_id, user_id, node_id)
);

-- =====================================================================
-- 5.6 Tutor
-- =====================================================================
create table public.tutor_threads (                       -- [sync: metadata] TUT-01…06, CAM-01.4
  id                       uuid primary key default public.uuid_v7(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  scope_type               text not null check (scope_type in ('subject','goal','topic','passage','capture')),
  subject_id               uuid references public.subjects(id) on delete cascade,
  goal_id                  uuid references public.goals(id) on delete cascade,
  node_id                  uuid references public.knowledge_nodes(id) on delete cascade,
  capture_id               uuid,                              -- camera_captures (Phase 3): FK added with that migration
  passage                  jsonb check (passage is null or jsonb_typeof(passage) = 'object'),
  mode                     text not null default 'answer' check (mode in ('answer','socratic','quiz')),
  title                    text check (char_length(title) <= 120),
  context_pages            jsonb not null default '[]'::jsonb check (jsonb_typeof(context_pages) = 'array'),
  state                    jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  continued_from_thread_id uuid references public.tutor_threads(id) on delete set null,
  last_message_at          timestamptz,
  archived_at              timestamptz,                       -- an archive, never a delete (R3)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  check (case scope_type
           when 'subject' then subject_id is not null
           when 'goal'    then goal_id is not null
           when 'topic'   then node_id is not null
           when 'passage' then passage is not null
           when 'capture' then capture_id is not null
         end)
);
create index tutor_threads_sync on public.tutor_threads (updated_at, id);
create index tutor_threads_user on public.tutor_threads (user_id, last_message_at desc) where deleted_at is null;

create table public.tutor_messages (                      -- TUT-01…06 (written by Edge Functions only)
  id               uuid primary key default public.uuid_v7(),
  thread_id        uuid not null references public.tutor_threads(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  role             text not null check (role in ('user','assistant','system_note')),
  content          text not null default '',
  raw_content      jsonb check (raw_content is null or jsonb_typeof(raw_content) = 'array'),
  citations        jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  mode             text not null check (mode in ('answer','socratic','quiz')),
  scope_snapshot   jsonb not null default '{}'::jsonb check (jsonb_typeof(scope_snapshot) = 'object'),
  retrieval        jsonb check (retrieval is null or jsonb_typeof(retrieval) = 'object'),
  tool_events      jsonb,
  general_knowledge boolean not null default false,
  voice            boolean not null default false,
  status           text not null default 'complete'
                   check (status in ('streaming','complete','interrupted','refused','failed')),
  safety_flag      text check (safety_flag in ('distress','blocked_content')),
  feedback         smallint check (feedback in (-1, 1)),
  feedback_reason  text check (char_length(feedback_reason) <= 500),
  ai_usage_id      uuid references public.ai_usage(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index tutor_messages_thread on public.tutor_messages (thread_id, created_at);

-- =====================================================================
-- Helpers used by the policies below (security definer, stable, search_path = '')
-- =====================================================================
create or replace function private.owns_exam(p_exam uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.exams e
                 where e.id = p_exam and e.user_id = auth.uid() and e.deleted_at is null);
$$;

create or replace function private.owns_goal(p_goal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.goals g
                 where g.id = p_goal and g.user_id = auth.uid() and g.deleted_at is null);
$$;

-- Hidden content (hidden_reason) is visible to app admins and to the moderators of a shared subject's Turma.
create or replace function private.can_moderate_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_app_admin() or exists (
    select 1 from public.subjects s
     where s.id = p_subject and s.owner_class_group_id is not null
       and private.is_moderator(s.owner_class_group_id));
$$;

-- Subject and personal owner of any R19 item. Items whose table is created later (feed_item,
-- podcast_episode, visual) return no row, so nobody can read or flag them yet.
-- tutor_message has no subject: its personal owner is the thread's user.
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
$$;

-- An item is visible under the R8 rule: its subject is readable and it is not someone else's personal item.
create or replace function private.can_see_item(p_type text, p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.item_scope(p_type, p_id) s
                 where (s.subj is not null and private.can_read_item(s.subj, s.personal))
                    or (s.subj is null and s.personal = auth.uid()));
$$;

-- =====================================================================
-- Triggers: updated_at maintenance and append-only guards (data-model §1.1, §1.3)
-- =====================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'notes','note_highlights','glossary_terms','glossary_term_overrides','explanations','card_overrides',
    'concept_contrasts','item_hides','content_flags','mastery','quizzes','quiz_attempts','attempt_answers',
    'mistakes','essays','exam_scope_items','exam_scope_nodes','grading_rules','grade_components',
    'study_sessions','availability_exceptions','desperate_modes','readiness_snapshots','teacher_profiles',
    'topic_predictions','exam_outcome_topics','tutor_threads','tutor_messages'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

create trigger topic_reads_append_only before update or delete on public.topic_reads
  for each row execute function private.forbid_mutation();
create trigger explanation_feedback_append_only before update or delete on public.explanation_feedback
  for each row execute function private.forbid_mutation();
create trigger item_revisions_append_only before update or delete on public.item_revisions
  for each row execute function private.forbid_mutation();
create trigger mastery_evidence_append_only before update or delete on public.mastery_evidence
  for each row execute function private.forbid_mutation();

-- Realtime (data-model §8.1): notes (generation status) and essays (async grading).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notes, public.essays;
  end if;
end $$;

-- =====================================================================
-- Row Level Security and grants (data-model §6.2, §6.3). Every table starts with no client access.
-- =====================================================================

-- ---- content_flags (TRU-02) ----------------------------------------
alter table public.content_flags enable row level security;
revoke all on public.content_flags from anon, authenticated;
grant select, insert on public.content_flags to authenticated;
grant insert (id, item_type, item_id, item_version, class_group_id, reporter_id, reason, comment)
  on public.content_flags to authenticated;   -- status and resolution are written by resolve_flag only
create policy content_flags_select on public.content_flags for select to authenticated
  using (reporter_id = auth.uid() or private.is_app_admin()
         or (class_group_id is not null and private.is_moderator(class_group_id)));
-- The flag's Turma must be the Turma that owns the item (null for personal items).
create policy content_flags_insert_reporter on public.content_flags for insert to authenticated
  with check (reporter_id = auth.uid()
              and private.can_see_item(item_type, item_id)
              and class_group_id is not distinct from (
                select s.owner_class_group_id from public.subjects s
                 where s.id = (select i.subj from private.item_scope(item_type, item_id) i)));

-- ---- notes (generated by the service) -----------------------------
alter table public.notes enable row level security;
revoke all on public.notes from anon, authenticated;
grant select on public.notes to authenticated;
create policy notes_select on public.notes for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- note_highlights ----------------------------------------------
alter table public.note_highlights enable row level security;
revoke all on public.note_highlights from anon, authenticated;
grant select, insert, update on public.note_highlights to authenticated;
grant insert (id, user_id, note_id, "start", "end", quote, color, orphaned) on public.note_highlights to authenticated;
grant update ("start", "end", quote, color, orphaned, deleted_at) on public.note_highlights to authenticated;
create policy note_highlights_select_own on public.note_highlights for select to authenticated
  using (user_id = auth.uid());
create policy note_highlights_insert_own on public.note_highlights for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.notes n where n.id = note_id));
create policy note_highlights_update_own on public.note_highlights for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.notes n where n.id = note_id));

-- ---- topic_reads (append-only) -------------------------------------
alter table public.topic_reads enable row level security;
revoke all on public.topic_reads from anon, authenticated;
grant select, insert on public.topic_reads to authenticated;
grant insert (id, user_id, node_id, depth, read_at, seconds) on public.topic_reads to authenticated;
create policy topic_reads_select_own on public.topic_reads for select to authenticated
  using (user_id = auth.uid());
create policy topic_reads_insert_own on public.topic_reads for insert to authenticated
  with check (user_id = auth.uid() and private.can_read_node(node_id));

-- ---- glossary_terms (generated by the service) ---------------------
alter table public.glossary_terms enable row level security;
revoke all on public.glossary_terms from anon, authenticated;
grant select on public.glossary_terms to authenticated;
create policy glossary_terms_select on public.glossary_terms for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- glossary_term_overrides (per user) ----------------------------
alter table public.glossary_term_overrides enable row level security;
revoke all on public.glossary_term_overrides from anon, authenticated;
grant select, insert, update on public.glossary_term_overrides to authenticated;
grant insert (user_id, term_id, definition, deleted_at) on public.glossary_term_overrides to authenticated;
grant update (definition, deleted_at) on public.glossary_term_overrides to authenticated;
create policy glossary_term_overrides_select_own on public.glossary_term_overrides for select to authenticated
  using (user_id = auth.uid());
create policy glossary_term_overrides_insert_own on public.glossary_term_overrides for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.glossary_terms t where t.id = term_id));
create policy glossary_term_overrides_update_own on public.glossary_term_overrides for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- explanations (service writes; the user saves personal ones) ----
alter table public.explanations enable row level security;
revoke all on public.explanations from anon, authenticated;
grant select on public.explanations to authenticated;
grant update (saved, deleted_at) on public.explanations to authenticated;
create policy explanations_select on public.explanations for select to authenticated
  using (private.can_read_item(subject_id, personal_for_user_id));
create policy explanations_update_own_personal on public.explanations for update to authenticated
  using (personal_for_user_id = auth.uid()) with check (personal_for_user_id = auth.uid());

-- ---- explanation_feedback (append-only) ----------------------------
alter table public.explanation_feedback enable row level security;
revoke all on public.explanation_feedback from anon, authenticated;
grant select, insert on public.explanation_feedback to authenticated;
grant insert (id, user_id, explanation_id, helpful) on public.explanation_feedback to authenticated;
create policy explanation_feedback_select_own on public.explanation_feedback for select to authenticated
  using (user_id = auth.uid());
create policy explanation_feedback_insert_own on public.explanation_feedback for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.explanations e where e.id = explanation_id));

-- ---- card_overrides (per user; shared-card fixes go through TRU-02) ----
alter table public.card_overrides enable row level security;
revoke all on public.card_overrides from anon, authenticated;
grant select, insert, update on public.card_overrides to authenticated;
grant insert (user_id, card_id, front, back, media, deleted_at) on public.card_overrides to authenticated;
grant update (front, back, media, deleted_at) on public.card_overrides to authenticated;
create policy card_overrides_select_own on public.card_overrides for select to authenticated
  using (user_id = auth.uid());
create policy card_overrides_insert_own on public.card_overrides for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.cards c where c.id = card_id));
create policy card_overrides_update_own on public.card_overrides for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- concept_contrasts (service writes) ----------------------------
alter table public.concept_contrasts enable row level security;
revoke all on public.concept_contrasts from anon, authenticated;
grant select on public.concept_contrasts to authenticated;
create policy concept_contrasts_select on public.concept_contrasts for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- item_revisions (append-only; written by resolve_flag) ---------
alter table public.item_revisions enable row level security;
revoke all on public.item_revisions from anon, authenticated;
grant select on public.item_revisions to authenticated;
create policy item_revisions_select on public.item_revisions for select to authenticated
  using (private.can_see_item(item_type, item_id));

-- ---- item_hides (per user, R7) -------------------------------------
alter table public.item_hides enable row level security;
revoke all on public.item_hides from anon, authenticated;
grant select, insert, update on public.item_hides to authenticated;
grant insert (user_id, item_type, item_id, reason) on public.item_hides to authenticated;
grant update (reason, deleted_at) on public.item_hides to authenticated;
create policy item_hides_select_own on public.item_hides for select to authenticated
  using (user_id = auth.uid());
create policy item_hides_insert_own on public.item_hides for insert to authenticated
  with check (user_id = auth.uid() and private.can_see_item(item_type, item_id));
create policy item_hides_update_own on public.item_hides for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and private.can_see_item(item_type, item_id));

-- ---- mastery (service writes; pull only) ---------------------------
alter table public.mastery enable row level security;
revoke all on public.mastery from anon, authenticated;
grant select on public.mastery to authenticated;
create policy mastery_select_own on public.mastery for select to authenticated
  using (user_id = auth.uid());

-- ---- mastery_evidence (append-only; service writes) ----------------
alter table public.mastery_evidence enable row level security;
revoke all on public.mastery_evidence from anon, authenticated;
grant select on public.mastery_evidence to authenticated;
create policy mastery_evidence_select_own on public.mastery_evidence for select to authenticated
  using (user_id = auth.uid());

-- ---- essays (own; grading columns are written by the service) ------
alter table public.essays enable row level security;
revoke all on public.essays from anon, authenticated;
grant select, insert, update on public.essays to authenticated;
grant insert (id, user_id, kind, theme_id, question_id, text, input_mode, image_paths, version, parent_essay_id)
  on public.essays to authenticated;
grant update (text, input_mode, image_paths, deleted_at) on public.essays to authenticated;
create policy essays_select_own on public.essays for select to authenticated
  using (user_id = auth.uid());
create policy essays_insert_own on public.essays for insert to authenticated
  with check (user_id = auth.uid()
              and (question_id is null or exists (select 1 from public.questions q where q.id = question_id)));
create policy essays_update_own_draft on public.essays for update to authenticated
  using (user_id = auth.uid() and status = 'draft')
  with check (user_id = auth.uid() and status = 'draft');

-- ---- quizzes (own; duel/battle/predicted/boss quizzes come from Edge Functions) ----
alter table public.quizzes enable row level security;
revoke all on public.quizzes from anon, authenticated;
grant select, insert, update on public.quizzes to authenticated;
grant insert (id, owner_id, subject_id, goal_id, exam_id, class_group_id, kind, mode, title, question_ids,
              time_limit_s, scope, config, seed) on public.quizzes to authenticated;
grant update (title, time_limit_s, deleted_at) on public.quizzes to authenticated;
create policy quizzes_select_own on public.quizzes for select to authenticated
  using (owner_id = auth.uid());
create policy quizzes_insert_own on public.quizzes for insert to authenticated
  with check (owner_id = auth.uid()
              and kind in ('practice','mock_exam','mistake_retry','feed')
              and (subject_id is null or private.can_read_subject(subject_id))
              and (goal_id is null or private.owns_goal(goal_id))
              and (exam_id is null or private.owns_exam(exam_id)));
create policy quizzes_update_own on public.quizzes for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---- quiz_attempts (own; scoring is written by quiz-submit) --------
alter table public.quiz_attempts enable row level security;
revoke all on public.quiz_attempts from anon, authenticated;
grant select, insert, update on public.quiz_attempts to authenticated;
grant insert (id, user_id, quiz_id, status, started_at, paused_seconds, device_id) on public.quiz_attempts to authenticated;
grant update (status, finished_at, paused_seconds, deleted_at) on public.quiz_attempts to authenticated;
create policy quiz_attempts_select_own on public.quiz_attempts for select to authenticated
  using (user_id = auth.uid());
create policy quiz_attempts_insert_own on public.quiz_attempts for insert to authenticated
  with check (user_id = auth.uid() and status = 'in_progress'
              and exists (select 1 from public.quizzes q
                          where q.id = quiz_id and q.owner_id = auth.uid()
                            and q.kind in ('practice','mock_exam','mistake_retry','feed')));
-- The client may pause or abandon an open attempt; submitting goes through quiz-submit.
create policy quiz_attempts_update_own on public.quiz_attempts for update to authenticated
  using (user_id = auth.uid() and status = 'in_progress')
  with check (user_id = auth.uid() and status in ('in_progress','abandoned'));

-- ---- attempt_answers (own, while the attempt is open) --------------
alter table public.attempt_answers enable row level security;
revoke all on public.attempt_answers from anon, authenticated;
grant select, insert, update on public.attempt_answers to authenticated;
grant insert (id, attempt_id, user_id, question_id, question_version, response, confidence, time_spent_ms,
              hints_used, solution_viewed, marked_for_review, self_override, input_mode, answered_at)
  on public.attempt_answers to authenticated;   -- correct, score and grading columns: service only
grant update (response, confidence, time_spent_ms, hints_used, solution_viewed, marked_for_review,
              self_override, answered_at, deleted_at) on public.attempt_answers to authenticated;
create policy attempt_answers_select_own on public.attempt_answers for select to authenticated
  using (user_id = auth.uid());
create policy attempt_answers_insert_own on public.attempt_answers for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.quiz_attempts a
                          where a.id = attempt_id and a.user_id = auth.uid() and a.status = 'in_progress')
              and exists (select 1 from public.questions q where q.id = question_id));
create policy attempt_answers_update_own on public.attempt_answers for update to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.quiz_attempts a
                                          where a.id = attempt_id and a.status = 'in_progress'))
  with check (user_id = auth.uid() and exists (select 1 from public.quiz_attempts a
                                               where a.id = attempt_id and a.status = 'in_progress'));

-- ---- mistakes (own) -----------------------------------------------
alter table public.mistakes enable row level security;
revoke all on public.mistakes from anon, authenticated;
grant select, insert, update on public.mistakes to authenticated;
grant insert (id, user_id, question_id, attempt_answer_id, subject_id, node_id, cause, suggested_cause,
              cause_source, user_note) on public.mistakes to authenticated;
grant update (cause, cause_source, user_note, next_retry_at, retry_step, success_days, resolved_at, deleted_at)
  on public.mistakes to authenticated;
create policy mistakes_select_own on public.mistakes for select to authenticated
  using (user_id = auth.uid());
create policy mistakes_insert_own on public.mistakes for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.attempt_answers aa
                          where aa.id = attempt_answer_id and aa.user_id = auth.uid()));
create policy mistakes_update_own on public.mistakes for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- exam_scope_items / exam_scope_nodes (own, via the parent exam) --
alter table public.exam_scope_items enable row level security;
revoke all on public.exam_scope_items from anon, authenticated;
grant select, insert, update on public.exam_scope_items to authenticated;
grant insert (id, exam_id, raw_text, position, status, placeholder_node_id, source_document_id)
  on public.exam_scope_items to authenticated;
grant update (raw_text, position, status, placeholder_node_id, source_document_id, deleted_at)
  on public.exam_scope_items to authenticated;
create policy exam_scope_items_select on public.exam_scope_items for select to authenticated
  using (private.owns_exam(exam_id));
create policy exam_scope_items_insert on public.exam_scope_items for insert to authenticated
  with check (private.owns_exam(exam_id)
              and (placeholder_node_id is null or private.can_read_node(placeholder_node_id)));
create policy exam_scope_items_update on public.exam_scope_items for update to authenticated
  using (private.owns_exam(exam_id)) with check (private.owns_exam(exam_id));

alter table public.exam_scope_nodes enable row level security;
revoke all on public.exam_scope_nodes from anon, authenticated;
grant select, insert, update on public.exam_scope_nodes to authenticated;
grant insert (exam_id, node_id, scope_item_id, source, confidence, confirmed) on public.exam_scope_nodes to authenticated;
grant update (scope_item_id, source, confidence, confirmed, deleted_at) on public.exam_scope_nodes to authenticated;
create policy exam_scope_nodes_select on public.exam_scope_nodes for select to authenticated
  using (private.owns_exam(exam_id));
create policy exam_scope_nodes_insert on public.exam_scope_nodes for insert to authenticated
  with check (private.owns_exam(exam_id) and private.can_read_node(node_id));
create policy exam_scope_nodes_update on public.exam_scope_nodes for update to authenticated
  using (private.owns_exam(exam_id)) with check (private.owns_exam(exam_id) and private.can_read_node(node_id));

-- ---- grading_rules (own) -------------------------------------------
alter table public.grading_rules enable row level security;
revoke all on public.grading_rules from anon, authenticated;
grant select, insert, update on public.grading_rules to authenticated;
grant insert (id, owner_profile_id, subject_id, school_year, formula, preset_key, template_class_group_id)
  on public.grading_rules to authenticated;
grant update (subject_id, school_year, formula, preset_key, template_class_group_id, deleted_at)
  on public.grading_rules to authenticated;
create policy grading_rules_select_own on public.grading_rules for select to authenticated
  using (owner_profile_id = auth.uid());
create policy grading_rules_insert_own on public.grading_rules for insert to authenticated
  with check (owner_profile_id = auth.uid()
              and (subject_id is null or private.can_read_subject(subject_id))
              and (template_class_group_id is null or private.is_member(template_class_group_id)));
create policy grading_rules_update_own on public.grading_rules for update to authenticated
  using (owner_profile_id = auth.uid()) with check (owner_profile_id = auth.uid());

-- ---- grade_components (own) ----------------------------------------
alter table public.grade_components enable row level security;
revoke all on public.grade_components from anon, authenticated;
grant select, insert, update on public.grade_components to authenticated;
grant insert (id, user_id, subject_id, school_year, term_index, name, kind, weight, max_points, grade, exam_id, position)
  on public.grade_components to authenticated;
grant update (school_year, term_index, name, kind, weight, max_points, grade, exam_id, position, deleted_at)
  on public.grade_components to authenticated;
create policy grade_components_select_own on public.grade_components for select to authenticated
  using (user_id = auth.uid());
create policy grade_components_insert_own on public.grade_components for insert to authenticated
  with check (user_id = auth.uid() and private.can_read_subject(subject_id)
              and (exam_id is null or private.owns_exam(exam_id)));
create policy grade_components_update_own on public.grade_components for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and (exam_id is null or private.owns_exam(exam_id)));

-- ---- study_sessions (own; client-generated ids) --------------------
alter table public.study_sessions enable row level security;
revoke all on public.study_sessions from anon, authenticated;
grant select, insert, update on public.study_sessions to authenticated;
grant insert (id, user_id, kind, plan_item_id, goal_id, started_at, ended_at, active_minutes, activities,
              planned_focus_minutes, cycles_planned, cycles_done, interruptions, blocked_attempts, dnd_used)
  on public.study_sessions to authenticated;
grant update (kind, plan_item_id, goal_id, ended_at, active_minutes, activities, planned_focus_minutes,
              cycles_planned, cycles_done, interruptions, blocked_attempts, dnd_used, deleted_at)
  on public.study_sessions to authenticated;
create policy study_sessions_select_own on public.study_sessions for select to authenticated
  using (user_id = auth.uid());
create policy study_sessions_insert_own on public.study_sessions for insert to authenticated
  with check (user_id = auth.uid() and (goal_id is null or private.owns_goal(goal_id)));
create policy study_sessions_update_own on public.study_sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and (goal_id is null or private.owns_goal(goal_id)));

-- ---- availability_exceptions (own; desperate rows are written by RPC only) ----
alter table public.availability_exceptions enable row level security;
revoke all on public.availability_exceptions from anon, authenticated;
grant select, insert, update on public.availability_exceptions to authenticated;
grant insert (user_id, local_date, minutes, source, deleted_at) on public.availability_exceptions to authenticated;
grant update (minutes, deleted_at) on public.availability_exceptions to authenticated;
create policy availability_exceptions_select_own on public.availability_exceptions for select to authenticated
  using (user_id = auth.uid());
create policy availability_exceptions_insert_own on public.availability_exceptions for insert to authenticated
  with check (user_id = auth.uid() and source = 'user');
create policy availability_exceptions_update_own on public.availability_exceptions for update to authenticated
  using (user_id = auth.uid() and source = 'user') with check (user_id = auth.uid() and source = 'user');

-- ---- desperate_modes (read own; written by the RPCs) ----------------
alter table public.desperate_modes enable row level security;
revoke all on public.desperate_modes from anon, authenticated;
grant select on public.desperate_modes to authenticated;
create policy desperate_modes_select_own on public.desperate_modes for select to authenticated
  using (user_id = auth.uid());

-- ---- readiness_snapshots (service writes) ---------------------------
alter table public.readiness_snapshots enable row level security;
revoke all on public.readiness_snapshots from anon, authenticated;
grant select on public.readiness_snapshots to authenticated;
create policy readiness_snapshots_select_own on public.readiness_snapshots for select to authenticated
  using (user_id = auth.uid());

-- ---- teacher_profiles (service writes; readable with the subject) --
alter table public.teacher_profiles enable row level security;
revoke all on public.teacher_profiles from anon, authenticated;
grant select on public.teacher_profiles to authenticated;
create policy teacher_profiles_select on public.teacher_profiles for select to authenticated
  using (private.can_read_subject(subject_id));

-- ---- topic_predictions (service writes; readable by the target's owner) ----
alter table public.topic_predictions enable row level security;
revoke all on public.topic_predictions from anon, authenticated;
grant select on public.topic_predictions to authenticated;
create policy topic_predictions_select on public.topic_predictions for select to authenticated
  using ((target_type = 'exam' and private.owns_exam(target_id))
         or (target_type = 'enem_goal' and private.owns_goal(target_id)));

-- ---- exam_outcome_topics (own) --------------------------------------
alter table public.exam_outcome_topics enable row level security;
revoke all on public.exam_outcome_topics from anon, authenticated;
grant select, insert, update on public.exam_outcome_topics to authenticated;
grant insert (exam_id, user_id, node_id) on public.exam_outcome_topics to authenticated;
grant update (deleted_at) on public.exam_outcome_topics to authenticated;
create policy exam_outcome_topics_select_own on public.exam_outcome_topics for select to authenticated
  using (user_id = auth.uid());
create policy exam_outcome_topics_insert_own on public.exam_outcome_topics for insert to authenticated
  with check (user_id = auth.uid() and private.owns_exam(exam_id) and private.can_read_node(node_id));
create policy exam_outcome_topics_update_own on public.exam_outcome_topics for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- tutor_threads (own; metadata sync) -----------------------------
alter table public.tutor_threads enable row level security;
revoke all on public.tutor_threads from anon, authenticated;
grant select, insert, update on public.tutor_threads to authenticated;
grant insert (id, user_id, scope_type, subject_id, goal_id, node_id, passage, mode, title, context_pages, state,
              continued_from_thread_id) on public.tutor_threads to authenticated;
grant update (title, mode, state, context_pages, archived_at, deleted_at) on public.tutor_threads to authenticated;
create policy tutor_threads_select_own on public.tutor_threads for select to authenticated
  using (user_id = auth.uid());
create policy tutor_threads_insert_own on public.tutor_threads for insert to authenticated
  with check (user_id = auth.uid()
              and (subject_id is null or private.can_read_subject(subject_id))
              and (goal_id is null or private.owns_goal(goal_id))
              and (node_id is null or private.can_read_node(node_id))
              and (continued_from_thread_id is null
                   or exists (select 1 from public.tutor_threads t
                              where t.id = continued_from_thread_id and t.user_id = auth.uid())));
create policy tutor_threads_update_own on public.tutor_threads for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- tutor_messages (Edge Functions write both turns; the user rates them) ----
alter table public.tutor_messages enable row level security;
revoke all on public.tutor_messages from anon, authenticated;
grant select, update on public.tutor_messages to authenticated;
grant update (feedback, feedback_reason) on public.tutor_messages to authenticated;
create policy tutor_messages_select_own on public.tutor_messages for select to authenticated
  using (user_id = auth.uid());
create policy tutor_messages_update_own on public.tutor_messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- calibration_stats (own rows through security_invoker) ----------
revoke all on public.calibration_stats from anon, authenticated;
grant select on public.calibration_stats to authenticated;

-- ---- Hidden content (TRU-02): restrictive guards on the tables that have hidden_reason --------
-- A restrictive policy is ANDed with the permissive ones, so hidden items disappear for everyone
-- except app admins and the Turma moderators of the subject.
create policy knowledge_nodes_hidden_guard on public.knowledge_nodes as restrictive for select to authenticated
  using (hidden_reason is null or private.can_moderate_subject(subject_id));
create policy cards_hidden_guard on public.cards as restrictive for select to authenticated
  using (hidden_reason is null or private.can_moderate_subject(subject_id));
create policy questions_hidden_guard on public.questions as restrictive for select to authenticated
  using (hidden_reason is null or private.can_moderate_subject(subject_id));
create policy glossary_terms_hidden_guard on public.glossary_terms as restrictive for select to authenticated
  using (hidden_reason is null or private.can_moderate_subject(subject_id));

-- ---- helper functions used by policies: executable by signed-in users only --------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'private.owns_exam(uuid)', 'private.owns_goal(uuid)', 'private.can_moderate_subject(uuid)',
    'private.item_scope(text,uuid)', 'private.can_see_item(text,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
