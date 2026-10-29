-- Trilha content written ahead, once per subject (ADR 0011, spec 14 §6–7). While a material is processed, every
-- concept gets its lesson, practice questions, a re-explanation from another angle with fresh questions, and
-- chapter-test questions; the subject gets its path order. Students' trails copy steps from here instead of waiting
-- on a model call, and classmates in a Turma share them like notes and cards ("generated once, used by everyone").
-- Only the API writes and reads these tables (service role); students see the copies in their own trail_steps.
create table public.trail_concept_content (                   -- [svc]
  concept_id                uuid primary key references public.knowledge_nodes(id) on delete cascade,  -- the topic itself when it has no concepts
  topic_id                  uuid not null references public.knowledge_nodes(id) on delete cascade,
  subject_id                uuid not null references public.subjects(id) on delete cascade,
  lesson                    jsonb not null check (jsonb_typeof(lesson) = 'object'),             -- {title, body, terms, source_pages}
  practice                  jsonb not null check (jsonb_typeof(practice) = 'array'),            -- questions asked right after the lesson
  remedial_lesson           jsonb check (remedial_lesson is null or jsonb_typeof(remedial_lesson) = 'object'),
  remedial_questions        jsonb not null default '[]'::jsonb check (jsonb_typeof(remedial_questions) = 'array'),
  test_questions            jsonb not null default '[]'::jsonb check (jsonb_typeof(test_questions) = 'array'),
  prompt_version            text not null,                    -- trail.lesson
  reinforce_prompt_version  text,                             -- trail.reinforce; null until it is written
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index trail_concept_content_topic on public.trail_concept_content (topic_id);
create trigger trail_concept_content_set_updated_at before update on public.trail_concept_content
  for each row execute function private.set_updated_at();

create table public.trail_subject_plans (                     -- [svc]
  subject_id      uuid primary key references public.subjects(id) on delete cascade,
  outline_hash    text not null,                              -- trailOutlineHash of the subject's map, before any student's exclusions
  goal            text,
  chapters        jsonb not null check (jsonb_typeof(chapters) = 'array'),   -- ProposedChapter[]: {topicId, why, conceptIds}
  prompt_version  text not null,                              -- trail.plan
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger trail_subject_plans_set_updated_at before update on public.trail_subject_plans
  for each row execute function private.set_updated_at();

alter table public.trail_concept_content enable row level security;
alter table public.trail_subject_plans enable row level security;
revoke all on public.trail_concept_content from anon, authenticated;
revoke all on public.trail_subject_plans from anon, authenticated;
