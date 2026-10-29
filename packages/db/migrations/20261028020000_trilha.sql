-- Trilha (TRL-01, spec 14): one guided path per student and subject. The API writes both tables (service role);
-- the student reads their own rows. `trails.plan` holds the chapter order (trail.plan, repaired against the
-- prerequisites); `trail_steps` holds every generated step — lessons, questions and chapter-test questions — with
-- the student's answer once given, so the path can be resumed at any time.
create table public.trails (                                  -- [svc]
  id               uuid primary key default public.uuid_v7(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  status           text not null default 'active' check (status in ('active','completed')),
  goal             text,                                       -- "ao fim da trilha você vai…" (trail.plan)
  plan             jsonb not null check (jsonb_typeof(plan) = 'array'),   -- TrailChapter[] in path order
  outline_hash     text not null,                              -- trailOutlineHash of the map the plan was built from
  chapter_index    int not null default 0 check (chapter_index >= 0),
  prompt_version   text,                                       -- null when the outline order was used (fallback)
  preparing_until  timestamptz,                                -- lease: one content generation at a time
  quiz_attempt_id  uuid references public.quiz_attempts(id) on delete set null,   -- holds the answers sent to the Caderno
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, subject_id)
);

create trigger trails_set_updated_at before update on public.trails
  for each row execute function private.set_updated_at();

create table public.trail_steps (                             -- [svc]
  id              uuid primary key default public.uuid_v7(),
  trail_id        uuid not null references public.trails(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  chapter_index   int not null check (chapter_index >= 0),
  topic_id        uuid not null references public.knowledge_nodes(id) on delete cascade,
  concept_id      uuid not null references public.knowledge_nodes(id) on delete cascade,   -- the topic itself when it has no concepts
  purpose         text not null check (purpose in ('lesson','practice','remedial_lesson','remedial_question','checkpoint')),
  round           int not null default 0 check (round >= 0),  -- chapter-test round; 0 while learning
  for_step_id     uuid references public.trail_steps(id) on delete set null,   -- remedial steps: the wrong answer they repair
  created_seq     int not null,                               -- creation order within the trail
  served_seq      int,                                        -- set when shown; history order
  status          text not null default 'ready' check (status in ('ready','done','discarded')),
  content         jsonb not null check (jsonb_typeof(content) = 'object'),
  source_pages    jsonb not null default '[]'::jsonb check (jsonb_typeof(source_pages) = 'array'),
  response        text,                                       -- chosen option id
  question_id     uuid references public.questions(id) on delete set null,   -- a missed question saved for the Caderno
  correct         boolean,
  answered_at     timestamptz,
  prompt_version  text not null,
  created_at      timestamptz not null default now(),
  unique (trail_id, created_seq)
);
create index trail_steps_chapter on public.trail_steps (trail_id, chapter_index, created_seq);

alter table public.trails enable row level security;
alter table public.trail_steps enable row level security;
revoke all on public.trails from anon, authenticated;
revoke all on public.trail_steps from anon, authenticated;
grant select on public.trails to authenticated;
grant select on public.trail_steps to authenticated;
create policy trails_select_own on public.trails for select to authenticated
  using (user_id = auth.uid());
create policy trail_steps_select_own on public.trail_steps for select to authenticated
  using (user_id = auth.uid());

-- Answers in the Trilha are mastery evidence like any other question (learning-engine §5.2, weight 1.0).
alter table public.mastery_evidence drop constraint mastery_evidence_source_check;
alter table public.mastery_evidence add constraint mastery_evidence_source_check
  check (source in ('quiz_answer','review','tutor_quiz','feed_question','duel','battle',
                    'teaching','boss','simulado','diagnostic','trail'));

-- Missed Trilha questions are saved as personal questions answered in one implicit attempt per trail, so the
-- Caderno de Erros (PRA-04) keeps them and schedules their retries like any other mistake.
alter table public.quizzes drop constraint quizzes_kind_check;
alter table public.quizzes add constraint quizzes_kind_check
  check (kind in ('practice','mock_exam','mistake_retry','feed','predicted_test','boss','duel','battle','enem_simulado','trail'));

-- "Explica de outro jeito" (LRN-03) on a Trilha lesson or question explains the step itself.
alter table public.explanations drop constraint explanations_target_type_check;
alter table public.explanations add constraint explanations_target_type_check
  check (target_type in ('note_paragraph','concept','glossary_term','question_explanation','card_back','trail_step'));
