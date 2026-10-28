-- Study time per topic and document (GOL-04 §8.2.2): the minutes a typical student needs to learn the topic from
-- that document's pages, estimated by ingest.topicDetail while it reads them. The planner sums them over the
-- topic's documents (documents without one fall back to the page formula); knowledge_nodes.est_learn_minutes caches
-- the sum for display. Shared by every student of the subject; the student's own pace is applied by the planner.
create table public.topic_study_estimates (                   -- [svc]
  node_id         uuid not null references public.knowledge_nodes(id) on delete cascade,
  document_id     uuid not null references public.documents(id) on delete cascade,
  minutes         int not null check (minutes between 1 and 600),
  prompt_version  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (node_id, document_id)
);

create trigger topic_study_estimates_set_updated_at before update on public.topic_study_estimates
  for each row execute function private.set_updated_at();

alter table public.topic_study_estimates enable row level security;
revoke all on public.topic_study_estimates from anon, authenticated;
