-- Phase 5: the rest (roadmap Phase 5). Auto visuals (LRN-05), material checker (ING-06), Estúdio de Mnemônicos
-- (MEM-06), energy-aware scheduling (GOL-10; GOL-09 calendar sync is device-only), Dividir e conquistar (SOC-06),
-- Perguntas da turma (SOC-07), Ligas semanais (SOC-08), Chefões (MOT-02), Retrospectiva (MOT-04) and the nudge log
-- shared by the prerequisite detective and the burnout guard (LRN-04.7, WEL-03; data-model R10).
-- Source: data-model.md §5.2, §5.3, §5.5, §5.7, §5.9 and §6.2. Conventions as in the earlier migrations.
--
-- Decisions beyond the data model, all recorded in data-model.md:
--   * material_findings.type follows the feature spec (ING-06.1: contradiction, numeric_or_formula_typo,
--     skipped_step, unclear) instead of the older data-model list. Votes go through vote_material_finding(),
--     which keeps the counters and the status consistent (ING-06.3).
--   * mnemonics.type follows MEM-06.2 (acronym, phrase, rhyme, story, palace, keyword). Mnemonics and palaces
--     need the network to be created (the options come from the AI), so the owner writes them directly under
--     RLS; the device pulls them for offline reviews.
--   * performance_windows.window is a reserved word in Postgres: the column is `bucket` (0–11, 2-hour buckets).
--   * visuals carry subject_id (denormalized from the node) so RLS does not join through knowledge_nodes, and
--     cache a "no diagram fits" answer as type 'none' (LRN-05.2) so the AI is not asked again.
--   * Pending peer questions (SOC-07.3) become readable by the Turma so members can vote on them; they stay out
--     of quizzes, which only take approved questions.
--   * contributions are private to their author and the Turma moderators; the divisão screen reads the claim
--     and submission state through divide_progress().

-- =====================================================================
-- LRN-05 Auto visuals
-- =====================================================================
create table public.visuals (
  id              uuid primary key default public.uuid_v7(),
  subject_id      uuid not null references public.subjects(id) on delete cascade,
  node_id         uuid not null references public.knowledge_nodes(id) on delete cascade,
  type            text not null check (type in ('flowchart','timeline','comparison_table','hierarchy','cycle','none')),
  title           text check (char_length(title) <= 120),
  spec            jsonb not null default '{}'::jsonb check (jsonb_typeof(spec) = 'object'),
  alt_text        text check (char_length(alt_text) <= 1000),
  source_pages    jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  status          text not null default 'ready' check (status in ('ready','failed')),
  prompt_version  text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (node_id, type)
);
create index visuals_subject on public.visuals (subject_id);

-- =====================================================================
-- ING-06 Material checker
-- =====================================================================
create table public.material_findings (
  id                   uuid primary key default public.uuid_v7(),
  document_id          uuid not null references public.documents(id) on delete cascade,
  subject_id           uuid not null references public.subjects(id) on delete cascade,
  node_id              uuid references public.knowledge_nodes(id) on delete set null,
  related_document_id  uuid references public.documents(id) on delete set null,   -- the other side of a contradiction
  type                 text not null check (type in ('contradiction','numeric_or_formula_typo','skipped_step','unclear')),
  severity             text not null check (severity in ('low','medium','high')),
  page_start           int not null check (page_start >= 1),
  page_end             int not null,
  related_page         int check (related_page >= 1),
  description          text not null check (char_length(description) between 1 and 600),
  suggested_fix        text check (char_length(suggested_fix) <= 600),
  status               text not null default 'open' check (status in ('open','dismissed','confirmed')),
  confirmations        int not null default 0 check (confirmations >= 0),
  dismissals           int not null default 0 check (dismissals >= 0),
  prompt_version       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (page_end >= page_start)
);
create index material_findings_document on public.material_findings (document_id, severity);
create index material_findings_node on public.material_findings (node_id) where node_id is not null;

create table public.material_finding_votes (
  finding_id  uuid not null references public.material_findings(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  vote        text not null check (vote in ('not_error','is_error')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (finding_id, user_id)
);

-- =====================================================================
-- MEM-06 Estúdio de Mnemônicos
-- =====================================================================
create table public.memory_palaces (                        -- [sync: pull] MEM-06.5
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  loci        jsonb not null check (jsonb_typeof(loci) = 'array' and jsonb_array_length(loci) between 2 and 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index memory_palaces_sync on public.memory_palaces (updated_at, id);

create table public.mnemonics (                             -- [sync: pull] MEM-06
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  card_id     uuid references public.cards(id) on delete cascade,
  node_id     uuid references public.knowledge_nodes(id) on delete cascade,
  type        text not null check (type in ('acronym','phrase','rhyme','story','palace','keyword')),
  title       text not null check (char_length(title) between 1 and 120),
  content     jsonb not null check (jsonb_typeof(content) = 'object'),   -- {text, items?, how_to_use?, loci?}
  palace_id   uuid references public.memory_palaces(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  check (card_id is not null or node_id is not null),
  check (type <> 'palace' or palace_id is not null)
);
-- One mnemonic per card for each user (MEM-06.4); a concept may keep several.
create unique index mnemonics_one_per_card on public.mnemonics (user_id, card_id) where card_id is not null and deleted_at is null;
create index mnemonics_sync on public.mnemonics (updated_at, id);

-- =====================================================================
-- GOL-10 Energy-aware windows (svc; computed nightly from review_logs and attempt_answers)
-- =====================================================================
create table public.performance_windows (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  bucket         smallint not null check (bucket between 0 and 11),     -- local 2-hour window: 0 = 00:00–01:59
  n_events       int not null default 0 check (n_events >= 0),
  mean_residual  real not null default 0,
  ci_low         real,
  ci_high        real,
  good           boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (user_id, bucket)
);

-- =====================================================================
-- SOC-06 Dividir e conquistar
-- =====================================================================
create table public.divide_plans (
  id              uuid primary key default public.uuid_v7(),
  class_group_id  uuid not null references public.class_groups(id) on delete cascade,
  subject_id      uuid not null references public.subjects(id) on delete cascade,
  exam_id         uuid references public.exams(id) on delete set null,
  title           text not null check (char_length(title) between 1 and 80),
  node_ids        uuid[] not null check (cardinality(node_ids) between 1 and 60),
  assignments     jsonb not null default '{}'::jsonb check (jsonb_typeof(assignments) = 'object'),   -- {node_id: user_id}
  max_claims      smallint not null default 3 check (max_claims between 1 and 10),
  status          text not null default 'open' check (status in ('open','merging','done','cancelled')),
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index divide_plans_group on public.divide_plans (class_group_id, status);

create table public.contributions (
  id              uuid primary key default public.uuid_v7(),
  divide_plan_id  uuid not null references public.divide_plans(id) on delete cascade,
  node_id         uuid not null references public.knowledge_nodes(id) on delete cascade,
  author_id       uuid not null references public.profiles(id) on delete cascade,
  body_md         text not null default '' check (char_length(body_md) <= 20000),
  input_mode      text not null default 'typed' check (input_mode in ('typed','photo')),
  capture_id      uuid references public.camera_captures(id) on delete set null,
  ai_feedback     jsonb,                                       -- private review (SOC-06.3)
  status          text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  submitted_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (divide_plan_id, node_id, author_id)
);

-- =====================================================================
-- SOC-07 Perguntas da turma
-- =====================================================================
-- Duplicate candidates for peer questions (spec 10 §7.3: Postgres full-text search over the topic's stems).
alter table public.questions
  add column stem_tsv tsvector generated always as (to_tsvector('simple', private.f_unaccent(coalesce(stem, '')))) stored;
create index questions_stem_tsv on public.questions using gin (stem_tsv);

create table public.question_votes (
  question_id  uuid not null references public.questions(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  vote         smallint not null default 1 check (vote = 1),
  created_at   timestamptz not null default now(),
  primary key (question_id, user_id)
);

-- =====================================================================
-- SOC-08 Ligas semanais (svc; the weekly job closes a week with ranks and badges)
-- =====================================================================
create table public.league_entries (
  class_group_id  uuid not null references public.class_groups(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  week_start      date not null check (extract(isodow from week_start) = 1),
  league_xp       int not null default 0 check (league_xp >= 0),
  rank            int check (rank >= 1),
  badges          text[] not null default '{}',
  reached_at      timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (class_group_id, user_id, week_start)
);

-- =====================================================================
-- MOT-02 Chefões, MOT-04 Retrospectiva
-- =====================================================================
create table public.boss_attempts (
  id               uuid primary key default public.uuid_v7(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  unit_node_id     uuid not null references public.knowledge_nodes(id) on delete cascade,
  quiz_attempt_id  uuid not null unique references public.quiz_attempts(id) on delete cascade,
  passed           boolean not null,
  score            real not null check (score between 0 and 1),
  created_at       timestamptz not null default now()
);
create index boss_attempts_user on public.boss_attempts (user_id, unit_node_id);

create table public.retrospectives (
  id            uuid primary key default public.uuid_v7(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  period_type   text not null check (period_type in ('goal','semester','year')),
  goal_id       uuid references public.goals(id) on delete set null,
  period_start  date not null,
  period_end    date not null,
  stats         jsonb not null check (jsonb_typeof(stats) = 'object'),
  title         text not null check (char_length(title) between 1 and 60),
  subtitle      text check (char_length(subtitle) <= 120),
  generated_at  timestamptz not null default now(),
  seen_at       timestamptz,
  check (period_end >= period_start),
  check (period_type <> 'goal' or goal_id is not null)
);
create unique index retrospectives_once on public.retrospectives
  (user_id, period_type, period_start, period_end, coalesce(goal_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- =====================================================================
-- R10 nudge log: prerequisite detective (LRN-04.7) and burnout guard (WEL-03)
-- =====================================================================
create table public.nudge_events (
  id               uuid primary key default public.uuid_v7(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  kind             text not null check (kind in ('prerequisite_detective','long_session','daily_load','late_night',
                                                 'performance_drop','overload_trend','checkin_low')),
  node_id          uuid references public.knowledge_nodes(id) on delete set null,
  related_node_id  uuid references public.knowledge_nodes(id) on delete set null,
  surface          text check (char_length(surface) <= 40),
  shown_at         timestamptz not null default now(),
  action           text check (action in ('acted','dismissed','accepted','disabled')),
  action_at        timestamptz
);
create index nudge_events_user on public.nudge_events (user_id, kind, shown_at);

-- =====================================================================
-- Triggers
-- =====================================================================
do $$
declare
  t text;
begin
  foreach t in array array['visuals','material_findings','material_finding_votes','memory_palaces','mnemonics',
                           'divide_plans','contributions','league_entries'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

create trigger boss_attempts_append_only before update or delete on public.boss_attempts
  for each row execute function private.forbid_mutation();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.visuals enable row level security;
revoke all on public.visuals from anon, authenticated;
grant select on public.visuals to authenticated;
create policy visuals_select on public.visuals for select to authenticated
  using (private.can_read_subject(subject_id));

alter table public.material_findings enable row level security;
revoke all on public.material_findings from anon, authenticated;
grant select on public.material_findings to authenticated;
create policy material_findings_select on public.material_findings for select to authenticated
  using (private.can_read_subject(subject_id));

alter table public.material_finding_votes enable row level security;
revoke all on public.material_finding_votes from anon, authenticated;
grant select on public.material_finding_votes to authenticated;
create policy material_finding_votes_select_own on public.material_finding_votes for select to authenticated
  using (user_id = auth.uid());

alter table public.memory_palaces enable row level security;
revoke all on public.memory_palaces from anon, authenticated;
grant select on public.memory_palaces to authenticated;
grant insert (id, user_id, name, loci) on public.memory_palaces to authenticated;
grant update (name, loci, deleted_at) on public.memory_palaces to authenticated;
create policy memory_palaces_select_own on public.memory_palaces for select to authenticated
  using (user_id = auth.uid());
create policy memory_palaces_insert_own on public.memory_palaces for insert to authenticated
  with check (user_id = auth.uid());
create policy memory_palaces_update_own on public.memory_palaces for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.mnemonics enable row level security;
revoke all on public.mnemonics from anon, authenticated;
grant select on public.mnemonics to authenticated;
grant insert (id, user_id, card_id, node_id, type, title, content, palace_id) on public.mnemonics to authenticated;
grant update (title, content, palace_id, deleted_at) on public.mnemonics to authenticated;
create policy mnemonics_select_own on public.mnemonics for select to authenticated
  using (user_id = auth.uid());
-- The card or concept must be readable, and a palace must be the user's own.
create policy mnemonics_insert_own on public.mnemonics for insert to authenticated
  with check (user_id = auth.uid()
              and (card_id is null or exists (select 1 from public.cards c
                                               where c.id = card_id and private.can_read_item(c.subject_id, c.personal_for_user_id)))
              and (node_id is null or exists (select 1 from public.knowledge_nodes n
                                               where n.id = node_id and private.can_read_subject(n.subject_id)))
              and (palace_id is null or exists (select 1 from public.memory_palaces p
                                                 where p.id = palace_id and p.user_id = auth.uid())));
create policy mnemonics_update_own on public.mnemonics for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and (palace_id is null or exists (select 1 from public.memory_palaces p
                                                 where p.id = palace_id and p.user_id = auth.uid())));

alter table public.performance_windows enable row level security;
revoke all on public.performance_windows from anon, authenticated;
grant select on public.performance_windows to authenticated;
create policy performance_windows_select_own on public.performance_windows for select to authenticated
  using (user_id = auth.uid());

alter table public.divide_plans enable row level security;
revoke all on public.divide_plans from anon, authenticated;
grant select on public.divide_plans to authenticated;
grant insert (id, class_group_id, subject_id, exam_id, title, node_ids, max_claims, created_by) on public.divide_plans to authenticated;
grant update (status) on public.divide_plans to authenticated;
create policy divide_plans_select on public.divide_plans for select to authenticated
  using (private.is_member(class_group_id));
-- A member opens a divisão on a subject of the Turma; every topic must belong to that subject (SOC-06.1).
create policy divide_plans_insert on public.divide_plans for insert to authenticated
  with check (created_by = auth.uid()
              and private.is_member(class_group_id)
              and exists (select 1 from public.subjects s
                          where s.id = subject_id and s.owner_class_group_id = class_group_id and s.deleted_at is null)
              and not exists (select 1 from unnest(node_ids) as x(node_id)
                              where not exists (select 1 from public.knowledge_nodes n
                                                where n.id = x.node_id and n.subject_id = divide_plans.subject_id))
              and (exam_id is null or exists (select 1 from public.exams e where e.id = exam_id and e.user_id = auth.uid())));
-- Only the creator or a moderator may cancel an open divisão; merging and done are set by the server.
create policy divide_plans_update on public.divide_plans for update to authenticated
  using ((created_by = auth.uid() or private.is_moderator(class_group_id)) and status = 'open')
  with check (status = 'cancelled');

alter table public.contributions enable row level security;
revoke all on public.contributions from anon, authenticated;
grant select on public.contributions to authenticated;
grant insert (id, divide_plan_id, node_id, author_id, body_md, input_mode, capture_id) on public.contributions to authenticated;
grant update (body_md, input_mode, capture_id) on public.contributions to authenticated;
create policy contributions_select on public.contributions for select to authenticated
  using (author_id = auth.uid()
         or exists (select 1 from public.divide_plans d
                    where d.id = divide_plan_id and private.is_moderator(d.class_group_id)));
-- Only for a topic the author claimed in an open divisão (SOC-06.2).
create policy contributions_insert on public.contributions for insert to authenticated
  with check (author_id = auth.uid()
              and exists (select 1 from public.divide_plans d
                          where d.id = divide_plan_id and d.status = 'open' and private.is_member(d.class_group_id)
                            and d.assignments ->> node_id::text = auth.uid()::text)
              and (capture_id is null or exists (select 1 from public.camera_captures c
                                                  where c.id = capture_id and c.user_id = auth.uid())));
-- Drafts only: once submitted, the text is moderated and reviewed server-side (SOC-06.3/.4).
create policy contributions_update on public.contributions for update to authenticated
  using (author_id = auth.uid() and status = 'draft')
  with check (author_id = auth.uid() and status = 'draft'
              and (capture_id is null or exists (select 1 from public.camera_captures c
                                                  where c.id = capture_id and c.user_id = auth.uid())));

alter table public.question_votes enable row level security;
revoke all on public.question_votes from anon, authenticated;
grant select on public.question_votes to authenticated;
create policy question_votes_select_own on public.question_votes for select to authenticated
  using (user_id = auth.uid());

alter table public.league_entries enable row level security;
revoke all on public.league_entries from anon, authenticated;
grant select on public.league_entries to authenticated;
create policy league_entries_select_own on public.league_entries for select to authenticated
  using (user_id = auth.uid());

alter table public.boss_attempts enable row level security;
revoke all on public.boss_attempts from anon, authenticated;
grant select on public.boss_attempts to authenticated;
create policy boss_attempts_select_own on public.boss_attempts for select to authenticated
  using (user_id = auth.uid());

alter table public.retrospectives enable row level security;
revoke all on public.retrospectives from anon, authenticated;
grant select on public.retrospectives to authenticated;
grant update (seen_at) on public.retrospectives to authenticated;
create policy retrospectives_select_own on public.retrospectives for select to authenticated
  using (user_id = auth.uid());
create policy retrospectives_update_own on public.retrospectives for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.nudge_events enable row level security;
revoke all on public.nudge_events from anon, authenticated;
grant select on public.nudge_events to authenticated;
grant insert (id, user_id, kind, node_id, related_node_id, surface, shown_at) on public.nudge_events to authenticated;
grant update (action, action_at) on public.nudge_events to authenticated;
create policy nudge_events_select_own on public.nudge_events for select to authenticated
  using (user_id = auth.uid());
create policy nudge_events_insert_own on public.nudge_events for insert to authenticated
  with check (user_id = auth.uid() and action is null);
create policy nudge_events_update_own on public.nudge_events for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- SOC-07.3: pending peer questions are readable by the Turma (to vote), never only by their author.
drop policy questions_select on public.questions;
create policy questions_select on public.questions for select to authenticated
  using (private.can_read_item(subject_id, personal_for_user_id)
         and (review_status = 'approved'
              or author_id = auth.uid()
              or (origin = 'peer' and review_status = 'pending')
              or exists (select 1 from public.subjects s
                         where s.id = subject_id and s.owner_class_group_id is not null
                           and private.is_moderator(s.owner_class_group_id))));

-- =====================================================================
-- RPCs
-- =====================================================================

-- ING-06.3: "Não é erro" / "É erro mesmo". A personal subject follows its owner's vote; in a Turma subject a
-- finding is confirmed with ≥ 2 confirmations and dismissed with ≥ 2 dismissals that outnumber them.
create or replace function public.vote_material_finding(p_finding uuid, p_vote text)
returns table (status text, confirmations int, dismissals int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_subject uuid;
  v_shared boolean;
  v_conf int;
  v_dism int;
  v_status text;
begin
  if p_vote not in ('not_error','is_error') then
    raise exception 'invalid vote' using errcode = '22023';
  end if;
  select f.subject_id, s.owner_class_group_id is not null into v_subject, v_shared
    from public.material_findings f join public.subjects s on s.id = f.subject_id
   where f.id = p_finding;
  if v_subject is null or not private.can_read_subject(v_subject) then
    raise exception 'finding not found' using errcode = 'P0002';
  end if;
  insert into public.material_finding_votes (finding_id, user_id, vote)
  values (p_finding, auth.uid(), p_vote)
  on conflict (finding_id, user_id) do update set vote = excluded.vote;
  select count(*) filter (where v.vote = 'is_error'), count(*) filter (where v.vote = 'not_error')
    into v_conf, v_dism
    from public.material_finding_votes v where v.finding_id = p_finding;
  if not v_shared then
    v_status := case when p_vote = 'is_error' then 'confirmed' else 'dismissed' end;
  elsif v_conf >= 2 then
    v_status := 'confirmed';
  elsif v_dism >= 2 and v_dism > v_conf then
    v_status := 'dismissed';
  else
    v_status := 'open';
  end if;
  update public.material_findings f
     set status = v_status, confirmations = v_conf, dismissals = v_dism
   where f.id = p_finding;
  return query select v_status, v_conf, v_dism;
end $$;

-- SOC-06.1: claim (or release) a topic of an open divisão; at most max_claims topics per member, one claimer per
-- topic. A topic with a submitted contribution cannot be released.
create or replace function public.claim_divide_topic(p_plan uuid, p_node uuid, p_claim boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.divide_plans%rowtype;
  v_owner text;
  v_mine int;
begin
  select * into v_plan from public.divide_plans where id = p_plan for update;
  if v_plan.id is null or not private.is_member(v_plan.class_group_id) then
    raise exception 'divisão not found' using errcode = 'P0002';
  end if;
  if v_plan.status <> 'open' then
    raise exception 'divisão is not open' using errcode = '55000';
  end if;
  if not (p_node = any (v_plan.node_ids)) then
    raise exception 'topic not in this divisão' using errcode = '22023';
  end if;
  v_owner := v_plan.assignments ->> p_node::text;
  if p_claim then
    if v_owner = auth.uid()::text then
      return v_plan.assignments;
    end if;
    if v_owner is not null then
      raise exception 'topic already claimed' using errcode = '23505';
    end if;
    select count(*) into v_mine from jsonb_each_text(v_plan.assignments) a where a.value = auth.uid()::text;
    if v_mine >= v_plan.max_claims then
      raise exception 'claim limit reached' using errcode = '54000';
    end if;
    update public.divide_plans set assignments = assignments || jsonb_build_object(p_node::text, auth.uid()::text)
     where id = p_plan returning assignments into v_plan.assignments;
  else
    if v_owner is distinct from auth.uid()::text then
      raise exception 'not your topic' using errcode = '42501';
    end if;
    if exists (select 1 from public.contributions c
                where c.divide_plan_id = p_plan and c.node_id = p_node and c.author_id = auth.uid()
                  and c.status in ('submitted','approved')) then
      raise exception 'contribution already submitted' using errcode = '55000';
    end if;
    delete from public.contributions c
     where c.divide_plan_id = p_plan and c.node_id = p_node and c.author_id = auth.uid() and c.status = 'draft';
    update public.divide_plans set assignments = assignments - p_node::text
     where id = p_plan returning assignments into v_plan.assignments;
  end if;
  return v_plan.assignments;
end $$;

-- SOC-06: who claimed each topic and how far their contribution is (no text, no feedback).
create or replace function public.divide_progress(p_plan uuid)
returns table (node_id uuid, user_id uuid, nickname text, status text)
language sql stable security definer set search_path = '' as $$
  select a.key::uuid, a.value::uuid, coalesce(m.nickname, p.display_name),
         coalesce((select c.status from public.contributions c
                    where c.divide_plan_id = d.id and c.node_id = a.key::uuid and c.author_id = a.value::uuid), 'claimed')
    from public.divide_plans d
    cross join lateral jsonb_each_text(d.assignments) a
    left join public.class_group_members m on m.class_group_id = d.class_group_id and m.user_id = a.value::uuid
    left join public.profiles p on p.id = a.value::uuid
   where d.id = p_plan and private.is_member(d.class_group_id);
$$;

-- SOC-07.3: 👍 on a pending peer question by another active member; 3 votes approve it.
create or replace function public.vote_peer_question(p_question uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_q record;
  v_votes int;
begin
  select q.id, q.author_id, q.review_status, q.origin, s.owner_class_group_id as group_id
    into v_q
    from public.questions q join public.subjects s on s.id = q.subject_id
   where q.id = p_question and q.deleted_at is null;
  if v_q.id is null or v_q.origin <> 'peer' or v_q.group_id is null or not private.is_member(v_q.group_id) then
    raise exception 'question not found' using errcode = 'P0002';
  end if;
  if v_q.author_id = auth.uid() then
    raise exception 'authors cannot vote on their own question' using errcode = '42501';
  end if;
  if v_q.review_status <> 'pending' then
    return v_q.review_status;
  end if;
  insert into public.question_votes (question_id, user_id) values (p_question, auth.uid())
  on conflict do nothing;
  select count(*) into v_votes
    from public.question_votes v
    join public.class_group_members m on m.user_id = v.user_id and m.class_group_id = v_q.group_id and m.status = 'active'
   where v.question_id = p_question;
  if v_votes >= 3 then
    update public.questions set review_status = 'approved' where id = p_question;
    return 'approved';
  end if;
  return 'pending';
end $$;

-- SOC-07.3: a moderator approves or rejects a pending peer question.
create or replace function public.review_peer_question(p_question uuid, p_approve boolean)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid;
  v_status text;
begin
  select s.owner_class_group_id into v_group
    from public.questions q join public.subjects s on s.id = q.subject_id
   where q.id = p_question and q.origin = 'peer' and q.deleted_at is null;
  if v_group is null or not private.is_moderator(v_group) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_status := case when p_approve then 'approved' else 'rejected' end;
  update public.questions set review_status = v_status where id = p_question;
  return v_status;
end $$;

-- SOC-08: the live board of the current week (or a closed week from league_entries). Only opted-in active
-- members see it; it lists the top 10 and the caller, never lower positions of others (SOC-08.3). League XP per
-- day excludes quiet-hours events and is capped at 500 (spec 10 §8.5); ties go to who reached the total first.
-- Blocked pairs are hidden from each other (SOC-X.3).
create or replace function public.league_board(p_group uuid, p_week date default null)
returns table (user_id uuid, nickname text, league_xp int, rank int, badges text[], is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_week date := coalesce(p_week, (date_trunc('week', (now() at time zone 'America/Sao_Paulo')))::date);
begin
  if not exists (select 1 from public.class_group_members m
                  where m.class_group_id = p_group and m.user_id = auth.uid() and m.status = 'active' and m.league_opt_in) then
    raise exception 'join the league first' using errcode = '42501';
  end if;
  return query
  with members as (
    select m.user_id, coalesce(m.nickname, p.display_name) as nickname
      from public.class_group_members m join public.profiles p on p.id = m.user_id
     where m.class_group_id = p_group and m.status = 'active' and m.league_opt_in
  ),
  live as (
    select d.user_id, sum(d.day_xp)::int as league_xp, max(d.last_at) as reached_at, '{}'::text[] as badges
      from (select x.user_id, x.local_date, least(sum(x.amount), 500) as day_xp, max(x.occurred_at) as last_at
              from public.xp_events x
             where x.user_id in (select members.user_id from members)
               and not x.in_quiet_hours
               and x.local_date between v_week and v_week + 6
             group by x.user_id, x.local_date) d
     group by d.user_id
  ),
  closed as (
    select e.user_id, e.league_xp, e.reached_at, e.badges
      from public.league_entries e
     where e.class_group_id = p_group and e.week_start = v_week
  ),
  source as (
    select * from closed
    union all
    select * from live where not exists (select 1 from closed)
  ),
  ranked as (
    select mb.user_id, mb.nickname, coalesce(s.league_xp, 0) as league_xp, coalesce(s.badges, '{}') as badges,
           rank() over (order by coalesce(s.league_xp, 0) desc, s.reached_at asc nulls last)::int as rank
      from members mb left join source s on s.user_id = mb.user_id
  )
  select r.user_id, r.nickname, r.league_xp, r.rank, r.badges, r.user_id = auth.uid()
    from ranked r
   where (r.rank <= 10 or r.user_id = auth.uid())
     and not exists (select 1 from public.user_blocks b
                      where (b.blocker_id = auth.uid() and b.blocked_id = r.user_id)
                         or (b.blocker_id = r.user_id and b.blocked_id = auth.uid()))
   order by r.rank, r.nickname;
end $$;

revoke all on function public.vote_material_finding(uuid, text) from public, anon;
revoke all on function public.claim_divide_topic(uuid, uuid, boolean) from public, anon;
revoke all on function public.divide_progress(uuid) from public, anon;
revoke all on function public.vote_peer_question(uuid) from public, anon;
revoke all on function public.review_peer_question(uuid, boolean) from public, anon;
revoke all on function public.league_board(uuid, date) from public, anon;
grant execute on function public.vote_material_finding(uuid, text) to authenticated;
grant execute on function public.claim_divide_topic(uuid, uuid, boolean) to authenticated;
grant execute on function public.divide_progress(uuid) to authenticated;
grant execute on function public.vote_peer_question(uuid) to authenticated;
grant execute on function public.review_peer_question(uuid, boolean) to authenticated;
grant execute on function public.league_board(uuid, date) to authenticated;
