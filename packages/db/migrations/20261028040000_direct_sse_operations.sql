-- Direct SSE operations replace pg-boss execution. ai_jobs remains a progress/read model for existing app builds.
alter table public.ai_jobs add column operation_id uuid;
create unique index ai_jobs_operation_id_key on public.ai_jobs(operation_id) where operation_id is not null;

-- Calendar triggers only: immediate requests never write here. No job status, workers, leases or retry loop.
create table private.scheduled_actions (
  id uuid primary key,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  due_at timestamptz not null,
  singleton_key text unique
);
alter table private.scheduled_actions enable row level security;
create index scheduled_actions_due_idx on private.scheduled_actions(due_at);
revoke all on private.scheduled_actions from public, anon, authenticated;
grant all on private.scheduled_actions to service_role;
