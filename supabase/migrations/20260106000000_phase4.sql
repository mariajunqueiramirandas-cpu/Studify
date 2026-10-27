-- Phase 4: ENEM mode (spec 09, ENM-01 … ENM-10; spec 08 ENM-08) and Treino de Argumentação (spec 12 INT-03).
-- Source: data-model.md §5.10 (ENEM), §5.8 (argument_sessions), §6.2 (matrix), §7 (`enem` bucket, created in
-- 20260101000200_storage.sql). Conventions as in the earlier migrations: text + CHECK enums, UUID v7 ids,
-- RLS on every table, service-role writes for reference data and anything the client must not forge.
--
-- Access decisions beyond the matrix (data-model §6.2), all stricter:
--   * enem_items: only published items (review_status = 'ok') are readable; the import and admin review run
--     with the service role (ENM-02.9). Their `questions` rows live in system subjects (subjects.system_kind)
--     and are readable through private.is_public_question, not through Turma membership.
--   * Atualidades: only published digests and items that were not withdrawn are readable (ENM-09).
--   * sisu_targets: owner only, never through the Turma (ENM-06.5).
--   * argument_sessions: the model-facing replay (raw_turns) is never selectable; every write goes through
--     argument-start / argument-turn / argument-finish.
--   * enem_skills descriptions are left for the admin to load from the official Matriz de Referência: the
--     structure (codes, areas, competências) is seeded here from spec 09 §8.2, the text is not invented.

-- =====================================================================
-- System subjects: the official ENEM bank and the Atualidades questions are global content (ENM-02.8, ENM-09)
-- =====================================================================
alter table public.subjects add column system_kind text;
alter table public.subjects add constraint subjects_system_kind_check check (system_kind in ('enem_bank','atualidades'));
create unique index subjects_system_kind on public.subjects (system_kind, enem_area) where system_kind is not null;

-- =====================================================================
-- ENM-01 structure
-- =====================================================================
create table public.enem_editions (
  year               int primary key check (year between 2009 and 2100),
  day1_date          date,
  day2_date          date check (day2_date is null or day1_date is null or day2_date >= day1_date),
  dates_status       text not null default 'provisional' check (dates_status in ('official','provisional')),
  gates_open         time,
  gates_close        time,
  start_time         time,
  timezone           text not null default 'America/Sao_Paulo',
  day1_duration_min  int check (day1_duration_min between 60 and 600),
  day2_duration_min  int check (day2_duration_min between 60 and 600),
  checklist          jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),
  edital_url         text,
  verified_at        timestamptz,
  verified_by        uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Never show unverified dates as official (data-model §5.10).
  check (dates_status <> 'official' or verified_at is not null)
);

create table public.enem_skills (
  code           text primary key check (code ~ '^(LC|CH|CN|MT)-H([1-9]|[12][0-9]|30)$'),
  area           text not null check (area in ('LC','CH','CN','MT')),
  competency_no  smallint not null check (competency_no between 1 and 9),
  skill_no       smallint not null check (skill_no between 1 and 30),
  description    text,
  unique (area, skill_no)
);

-- Spec 09 §8.2: competência → habilidades per area (Matriz de Referência).
insert into public.enem_skills (code, area, competency_no, skill_no)
select a.area || '-H' || h, a.area,
       (select c.no from (values
          -- LC (9)
          ('LC', 1, 1, 4), ('LC', 2, 5, 8), ('LC', 3, 9, 11), ('LC', 4, 12, 14), ('LC', 5, 15, 17),
          ('LC', 6, 18, 20), ('LC', 7, 21, 24), ('LC', 8, 25, 27), ('LC', 9, 28, 30),
          -- MT (7)
          ('MT', 1, 1, 5), ('MT', 2, 6, 9), ('MT', 3, 10, 14), ('MT', 4, 15, 18), ('MT', 5, 19, 23),
          ('MT', 6, 24, 26), ('MT', 7, 27, 30),
          -- CN (8)
          ('CN', 1, 1, 4), ('CN', 2, 5, 7), ('CN', 3, 8, 12), ('CN', 4, 13, 16), ('CN', 5, 17, 19),
          ('CN', 6, 20, 23), ('CN', 7, 24, 27), ('CN', 8, 28, 30),
          -- CH (6)
          ('CH', 1, 1, 5), ('CH', 2, 6, 10), ('CH', 3, 11, 15), ('CH', 4, 16, 20), ('CH', 5, 21, 25),
          ('CH', 6, 26, 30)
        ) as c(area, no, lo, hi)
        where c.area = a.area and h between c.lo and c.hi),
       h
  from (values ('LC'), ('CH'), ('CN'), ('MT')) as a(area)
 cross join generate_series(1, 30) as h;

create table public.enem_topics (
  id          uuid primary key default public.uuid_v7(),
  area        text not null check (area in ('LC','CH','CN','MT')),
  subject     text not null check (char_length(subject) between 1 and 60),
  parent_id   uuid references public.enem_topics(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 160),
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index enem_topics_area on public.enem_topics (area, parent_id, position);

create table public.knowledge_node_enem_topics (
  node_id        uuid not null references public.knowledge_nodes(id) on delete cascade,
  enem_topic_id  uuid not null references public.enem_topics(id) on delete cascade,
  confidence     real not null check (confidence between 0 and 1),
  created_at     timestamptz not null default now(),
  primary key (node_id, enem_topic_id)
);
create index knowledge_node_enem_topics_topic on public.knowledge_node_enem_topics (enem_topic_id);

-- =====================================================================
-- ENM-02 bank (global, imported by enem.import_edition)
-- =====================================================================
create table public.enem_items (
  id                  uuid primary key default public.uuid_v7(),
  question_id         uuid not null unique references public.questions(id) on delete cascade,
  edition_year        int not null check (edition_year between 1998 and 2100),
  application         text not null default 'regular' check (application in ('regular','ppl','other')),
  day                 smallint not null check (day in (1, 2)),
  area                text not null check (area in ('LC','CH','CN','MT')),
  co_item             text not null check (char_length(co_item) between 1 and 40),
  positions           jsonb not null default '[]'::jsonb check (jsonb_typeof(positions) = 'array'),   -- [{co_prova, color, position}]
  answer_key          text check (answer_key in ('A','B','C','D','E')),
  skill_code          text references public.enem_skills(code),
  language            text check (language in ('en','es')),
  annulled            boolean not null default false,
  annul_reason        text,
  crop_paths          text[] not null default '{}',                                                 -- enem/{year}/{co_item}/{n}.webp
  transcription_md    text,
  alt_text            text,
  enem_topic_ids      uuid[] not null default '{}',
  subject             text,
  explanation_status  text not null default 'pending' check (explanation_status in ('pending','ok','flagged')),
  review_status       text not null default 'needs_review' check (review_status in ('ok','needs_review')),
  review_notes        text[] not null default '{}',                                                 -- why it waits for review (ENM-02.9)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (edition_year, application, co_item)
);
create index enem_items_published on public.enem_items (area, edition_year) where review_status = 'ok' and not annulled;
create index enem_items_skill on public.enem_items (skill_code) where review_status = 'ok';
create index enem_items_topics on public.enem_items using gin (enem_topic_ids);

create table public.enem_item_params (
  enem_item_id  uuid primary key references public.enem_items(id) on delete cascade,
  a             numeric not null check (a > 0),
  b             numeric not null,
  c             numeric not null check (c between 0 and 1),
  scale         text not null default 'std' check (scale in ('std','enem')),
  source        text not null check (char_length(source) between 1 and 60),                         -- microdata_<year>
  logistic_d    numeric not null default 1.0 check (logistic_d in (1.0, 1.7)),
  created_at    timestamptz not null default now()
);

-- =====================================================================
-- ENM-08 statistics (derived by enem.topic_stats) and past redação themes
-- =====================================================================
create table public.enem_topic_stats (
  enem_topic_id    uuid not null references public.enem_topics(id) on delete cascade,
  edition_year     int not null,
  area             text not null check (area in ('LC','CH','CN','MT')),
  item_count       int not null check (item_count >= 0),
  area_item_count  int not null check (area_item_count >= 0),
  share            real not null check (share between 0 and 1),
  primary key (enem_topic_id, edition_year)
);

create table public.enem_topic_trends (
  enem_topic_id    uuid primary key references public.enem_topics(id) on delete cascade,
  share_last10     real not null check (share_last10 between 0 and 1),
  share_recent5    real not null check (share_recent5 between 0 and 1),
  share_prev5      real not null check (share_prev5 between 0 and 1),
  trend            text not null check (trend in ('up','flat','down')),
  predicted_share  real not null check (predicted_share between 0 and 1),
  computed_at      timestamptz not null default now()
);

create table public.enem_redacao_themes (
  edition_year  int not null,
  application   text not null default 'regular' check (application in ('regular','ppl','other')),
  theme         text not null check (char_length(theme) between 5 and 300),
  source_url    text,
  primary key (edition_year, application)
);

-- ENM-08.5: themes of the regular application, as published by Inep. The source link is filled by the admin.
insert into public.enem_redacao_themes (edition_year, application, theme) values
  (2009, 'regular', 'O indivíduo frente à ética nacional'),
  (2010, 'regular', 'O trabalho na construção da dignidade humana'),
  (2011, 'regular', 'Viver em rede no século XXI: os limites entre o público e o privado'),
  (2012, 'regular', 'Movimento imigratório para o Brasil no século XXI'),
  (2013, 'regular', 'Efeitos da implantação da Lei Seca no Brasil'),
  (2014, 'regular', 'Publicidade infantil em questão no Brasil'),
  (2015, 'regular', 'A persistência da violência contra a mulher na sociedade brasileira'),
  (2016, 'regular', 'Caminhos para combater a intolerância religiosa no Brasil'),
  (2017, 'regular', 'Desafios para a formação educacional de surdos no Brasil'),
  (2018, 'regular', 'Manipulação do comportamento do usuário pelo controle de dados na internet'),
  (2019, 'regular', 'Democratização do acesso ao cinema no Brasil'),
  (2020, 'regular', 'O estigma associado às doenças mentais na sociedade brasileira'),
  (2021, 'regular', 'Invisibilidade e registro civil: garantia de acesso à cidadania no Brasil'),
  (2022, 'regular', 'Desafios para a valorização de comunidades e povos tradicionais no Brasil'),
  (2023, 'regular', 'Desafios para o enfrentamento da invisibilidade do trabalho de cuidado realizado pela mulher no Brasil'),
  (2024, 'regular', 'Desafios para a valorização da herança africana no Brasil');

-- =====================================================================
-- ENM-05 themes and repertório
-- =====================================================================
create table public.essay_themes (
  id                  uuid primary key default public.uuid_v7(),
  title               text not null check (char_length(title) between 5 and 300),
  axis                text check (char_length(axis) <= 80),
  source              text not null check (source in ('past_enem','predicted','atualidades','custom')),
  edition_year        int,
  prompt              jsonb not null default '{}'::jsonb check (jsonb_typeof(prompt) = 'object'),   -- {instruction, motivating_texts:[{label, text_md, source_name, source_url}]}
  rationale           text,
  connections         jsonb not null default '[]'::jsonb check (jsonb_typeof(connections) = 'array'),
  proposal_crop_path  text,
  valid_until         date,
  created_by          uuid references public.profiles(id) on delete cascade,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  check (source <> 'custom' or created_by is not null)
);
create index essay_themes_source on public.essay_themes (source, created_at desc) where deleted_at is null;

alter table public.essays add constraint essays_theme_id_fkey foreign key (theme_id) references public.essay_themes(id) on delete set null;

create table public.atualidades_digests (
  id            uuid primary key default public.uuid_v7(),
  week_start    date not null unique,
  status        text not null default 'draft' check (status in ('draft','published','withdrawn')),
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (status <> 'published' or published_at is not null)
);

create table public.atualidades_items (
  id             uuid primary key default public.uuid_v7(),
  digest_id      uuid not null references public.atualidades_digests(id) on delete cascade,
  position       smallint not null default 0,
  title          text not null check (char_length(title) between 3 and 200),
  summary_md     text not null,
  why_md         text not null,
  areas          text[] not null default '{}',
  skill_codes    text[] not null default '{}',
  redacao_axes   text[] not null default '{}',
  repertorio     jsonb not null default '[]'::jsonb check (jsonb_typeof(repertorio) = 'array'),
  sources        jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1),
  question_ids   uuid[] not null default '{}',
  withdrawn      boolean not null default false,                                   -- spec 09 §9: retracted source
  created_at     timestamptz not null default now()
);
create index atualidades_items_digest on public.atualidades_items (digest_id, position);

create table public.repertorio_items (                          -- [sync-free: written by the client, own rows]
  id                   uuid primary key default public.uuid_v7(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  kind                 text not null check (kind in ('quote','data','law','work','event')),
  text                 text not null check (char_length(text) between 3 and 2000),
  source_url           text,
  source_name          text,
  verified             text not null default 'no' check (verified in ('yes','no','contradicted')),
  atualidades_item_id  uuid references public.atualidades_items(id) on delete set null,
  tags                 text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index repertorio_items_user on public.repertorio_items (user_id, updated_at);

-- =====================================================================
-- ENM-06 Meta SISU
-- =====================================================================
create table public.sisu_offers (
  id                   uuid primary key default public.uuid_v7(),
  edition_year         int not null,
  institution          text not null,
  institution_acronym  text,
  campus               text,
  course               text not null,
  degree               text,
  shift                text,
  weights              jsonb not null check (jsonb_typeof(weights) = 'object'),        -- {LC, CH, CN, MT, RED}
  min_scores           jsonb not null default '{}'::jsonb check (jsonb_typeof(min_scores) = 'object'),
  cutoffs              jsonb not null default '[]'::jsonb check (jsonb_typeof(cutoffs) = 'array'),   -- [{modality_label, cutoff, edition}]
  source               text not null check (source in ('open_data','edital','manual_admin')),
  source_url           text,
  verified_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index sisu_offers_course on public.sisu_offers (lower(course), lower(institution));

create table public.sisu_targets (
  id              uuid primary key default public.uuid_v7(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  goal_id         uuid not null references public.goals(id) on delete cascade,
  offer_id        uuid references public.sisu_offers(id) on delete set null,
  manual          jsonb check (manual is null or jsonb_typeof(manual) = 'object'),   -- {label, weights, min_scores}
  cutoff_used     numeric not null check (cutoff_used between 0 and 1000),
  modality_label  text check (char_length(modality_label) <= 60),
  margin          numeric not null default 15 check (margin between 0 and 200),
  priority        smallint not null default 1 check (priority between 1 and 3),
  targets         jsonb check (targets is null or jsonb_typeof(targets) = 'object'),
  computed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (offer_id is not null or manual is not null)
);
create unique index sisu_targets_priority on public.sisu_targets (goal_id, priority) where deleted_at is null;

-- =====================================================================
-- INT-03 Treino de Argumentação
-- =====================================================================
create table public.argument_sessions (
  id               uuid primary key default public.uuid_v7(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  goal_mode        text not null check (goal_mode in ('exam_week','enem')),
  subject_id       uuid references public.subjects(id) on delete set null,
  theme            text not null check (char_length(theme) between 5 and 300),
  theme_id         uuid references public.essay_themes(id) on delete set null,
  theme_source     text not null check (theme_source in ('suggested','enem','custom')),
  mode             text not null check (mode in ('debate','build')),
  thesis           text check (char_length(thesis) <= 600),
  thesis_feedback  jsonb,
  rounds           jsonb not null default '[]'::jsonb check (jsonb_typeof(rounds) = 'array'),     -- what the app shows
  round_limit      smallint not null default 4 check (round_limit between 3 and 5),
  raw_turns        jsonb not null default '[]'::jsonb check (jsonb_typeof(raw_turns) = 'array'),  -- server-only replay
  context          jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),   -- server-only: node, stored slices
  rubric           jsonb,
  summary          jsonb,
  outline          jsonb,
  essay_id         uuid references public.essays(id) on delete set null,
  status           text not null default 'active' check (status in ('active','finished','abandoned')),
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index argument_sessions_user on public.argument_sessions (user_id, created_at desc) where deleted_at is null;

-- =====================================================================
-- Helpers (security definer, stable, search_path = '')
-- =====================================================================
-- Questions of the global ENEM bank (published items) and of published Atualidades digests are readable by
-- every signed-in student (ENM-02, ENM-09); everything else keeps the Turma rules of can_read_item.
create or replace function private.is_public_question(p_question uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.enem_items e
                  where e.question_id = p_question and e.review_status = 'ok')
      or exists (select 1 from public.atualidades_items i
                   join public.atualidades_digests d on d.id = i.digest_id
                  where p_question = any (i.question_ids) and not i.withdrawn and d.status = 'published');
$$;

revoke all on function private.is_public_question(uuid) from public, anon;
grant execute on function private.is_public_question(uuid) to authenticated, service_role;

-- updated_at maintenance (data-model §1.1).
do $$
declare
  t text;
begin
  foreach t in array array[
    'enem_editions','enem_topics','enem_items','essay_themes','atualidades_digests','repertorio_items',
    'sisu_offers','sisu_targets','argument_sessions'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

-- =====================================================================
-- Row Level Security and grants (data-model §6.2)
-- =====================================================================

-- ---- reference data: any signed-in user reads, the service role writes ----
do $$
declare
  t text;
begin
  foreach t in array array['enem_editions','enem_skills','enem_topics','enem_item_params','enem_topic_stats',
                           'enem_topic_trends','enem_redacao_themes','sisu_offers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- enem_item_params of unpublished items stay hidden like the items themselves.
drop policy enem_item_params_read on public.enem_item_params;
create policy enem_item_params_read on public.enem_item_params for select to authenticated
  using (exists (select 1 from public.enem_items e where e.id = enem_item_id and e.review_status = 'ok'));

-- ---- enem_items: published only (ENM-02.9) ----
alter table public.enem_items enable row level security;
revoke all on public.enem_items from anon, authenticated;
grant select on public.enem_items to authenticated;
create policy enem_items_read on public.enem_items for select to authenticated
  using (review_status = 'ok' or private.is_app_admin());

-- ---- knowledge_node_enem_topics: readers of the node's subject; written by enem.tagNodes ----
alter table public.knowledge_node_enem_topics enable row level security;
revoke all on public.knowledge_node_enem_topics from anon, authenticated;
grant select on public.knowledge_node_enem_topics to authenticated;
create policy knowledge_node_enem_topics_read on public.knowledge_node_enem_topics for select to authenticated
  using (exists (select 1 from public.knowledge_nodes n where n.id = node_id and private.can_read_subject(n.subject_id)));

-- ---- questions and subjects of the global content ----
create policy questions_select_public on public.questions for select to authenticated
  using (private.is_public_question(id));
create policy subjects_select_system on public.subjects for select to authenticated
  using (system_kind is not null and deleted_at is null);

-- ---- essay_themes: non-custom for everyone, custom only for its author ----
alter table public.essay_themes enable row level security;
revoke all on public.essay_themes from anon, authenticated;
grant select on public.essay_themes to authenticated;
grant insert (id, title, axis, source, prompt, created_by) on public.essay_themes to authenticated;
grant update (title, axis, prompt, deleted_at) on public.essay_themes to authenticated;
create policy essay_themes_select on public.essay_themes for select to authenticated
  using ((source <> 'custom' and deleted_at is null) or created_by = auth.uid());
create policy essay_themes_insert_custom on public.essay_themes for insert to authenticated
  with check (source = 'custom' and created_by = auth.uid());
create policy essay_themes_update_custom on public.essay_themes for update to authenticated
  using (source = 'custom' and created_by = auth.uid())
  with check (source = 'custom' and created_by = auth.uid());

-- ---- Atualidades: published digests, items not withdrawn ----
alter table public.atualidades_digests enable row level security;
revoke all on public.atualidades_digests from anon, authenticated;
grant select on public.atualidades_digests to authenticated;
create policy atualidades_digests_read on public.atualidades_digests for select to authenticated
  using (status = 'published' or private.is_app_admin());

alter table public.atualidades_items enable row level security;
revoke all on public.atualidades_items from anon, authenticated;
grant select on public.atualidades_items to authenticated;
create policy atualidades_items_read on public.atualidades_items for select to authenticated
  using ((not withdrawn and exists (select 1 from public.atualidades_digests d where d.id = digest_id and d.status = 'published'))
         or private.is_app_admin());

-- ---- repertorio_items: own CRUD ----
alter table public.repertorio_items enable row level security;
revoke all on public.repertorio_items from anon, authenticated;
grant select on public.repertorio_items to authenticated;
grant insert (id, user_id, kind, text, source_url, source_name, atualidades_item_id, tags) on public.repertorio_items to authenticated;
grant update (kind, text, source_url, source_name, tags, deleted_at) on public.repertorio_items to authenticated;
grant delete on public.repertorio_items to authenticated;
create policy repertorio_items_select_own on public.repertorio_items for select to authenticated using (user_id = auth.uid());
create policy repertorio_items_insert_own on public.repertorio_items for insert to authenticated with check (user_id = auth.uid());
create policy repertorio_items_update_own on public.repertorio_items for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy repertorio_items_delete_own on public.repertorio_items for delete to authenticated using (user_id = auth.uid());

-- ---- sisu_targets: own, on own goals (ENM-06.5: never visible to the Turma) ----
alter table public.sisu_targets enable row level security;
revoke all on public.sisu_targets from anon, authenticated;
grant select on public.sisu_targets to authenticated;
grant insert (id, user_id, goal_id, offer_id, manual, cutoff_used, modality_label, margin, priority, targets, computed_at)
  on public.sisu_targets to authenticated;
grant update (offer_id, manual, cutoff_used, modality_label, margin, priority, targets, computed_at, deleted_at)
  on public.sisu_targets to authenticated;
create policy sisu_targets_select_own on public.sisu_targets for select to authenticated using (user_id = auth.uid());
create policy sisu_targets_insert_own on public.sisu_targets for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid() and g.mode = 'enem'));
create policy sisu_targets_update_own on public.sisu_targets for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- argument_sessions: own; replay never selectable ----
alter table public.argument_sessions enable row level security;
revoke all on public.argument_sessions from anon, authenticated;
grant select (id, user_id, goal_mode, subject_id, theme, theme_id, theme_source, mode, thesis, thesis_feedback, rounds,
              round_limit, rubric, summary, outline, essay_id, status, finished_at, created_at, updated_at, deleted_at)
  on public.argument_sessions to authenticated;
grant update (deleted_at) on public.argument_sessions to authenticated;
create policy argument_sessions_select_own on public.argument_sessions for select to authenticated
  using (user_id = auth.uid());
create policy argument_sessions_update_own on public.argument_sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Realtime (data-model §8.1): the ENEM essay result arrives while the student waits on the screen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'essays') then
    alter publication supabase_realtime add table public.essays;
  end if;
end $$;

-- =====================================================================
-- Storage: the enem bucket also holds the raw INEP files the import reads (enem/{year}/raw/…: booklet PDFs,
-- the ITENS_PROVA microdata CSV, answer keys, manifest.json). Item crops are WebP, JPEG when WebP encoding is
-- unavailable. Guarded like 20260101000200_storage.sql.
-- =====================================================================
do $$
begin
  if to_regnamespace('storage') is null then
    return;
  end if;
  update storage.buckets
     set allowed_mime_types = array['image/webp','image/jpeg','application/pdf','text/csv','text/plain','application/json']
   where id = 'enem';
end $$;

-- =====================================================================
-- Atualidades source allowlist (ENM-09.3, spec 09 §12 open question 5: initial list as proposed). Admin-maintained;
-- the weekly research call passes the enabled domains as allowed_domains. Service role only.
-- =====================================================================
create table private.atualidades_sources (
  domain      text primary key check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  name        text not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
insert into private.atualidades_sources (domain, name) values
  ('agenciabrasil.ebc.com.br', 'Agência Brasil'),
  ('ibge.gov.br', 'IBGE'),
  ('ipea.gov.br', 'Ipea'),
  ('fiocruz.br', 'Fiocruz'),
  ('bbc.com', 'BBC News Brasil'),
  ('nexojornal.com.br', 'Nexo'),
  ('g1.globo.com', 'g1'),
  ('folha.uol.com.br', 'Folha de S.Paulo'),
  ('estadao.com.br', 'Estadão'),
  ('brasil.un.org', 'ONU Brasil'),
  ('unicef.org', 'UNICEF Brasil');
alter table private.atualidades_sources enable row level security;   -- no policies: service role only
revoke all on private.atualidades_sources from public;
