-- AI plan coach (GOL-04.10): one row per student with the latest strategy the planner used. The worker writes
-- it (service role); the student reads their own row on Hoje. Topic priorities feed buildPlan as topic weights,
-- and the per-topic reasons travel in plan_items.reason_params, so this row only serves the coach card.
create table public.plan_coach (                              -- [svc]
  user_id         uuid primary key references public.profiles(id) on delete cascade,
  plan_run_id     uuid references public.plan_runs(id) on delete set null,
  local_date      date not null,                           -- study day the coach output was written for
  signals_hash    text not null,                           -- the coached signals; same hash → no new AI call
  output          jsonb not null check (jsonb_typeof(output) = 'object'),
  prompt_version  text not null,
  calls_date      date not null,                           -- daily AI call cap (worker)
  calls_today     int not null default 0 check (calls_today >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger plan_coach_set_updated_at before update on public.plan_coach
  for each row execute function private.set_updated_at();

alter table public.plan_coach enable row level security;
revoke all on public.plan_coach from anon, authenticated;
grant select on public.plan_coach to authenticated;
create policy plan_coach_select_own on public.plan_coach for select to authenticated
  using (user_id = auth.uid());
