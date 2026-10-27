-- Integration pass (contract mismatches between the schema and the code that writes to it). Additive and
-- constraint-replacing only: earlier migrations are not edited, and each replaced CHECK keeps every value it had.
-- battles.status is unchanged on purpose: the worker moves to `reveal` (the value the schema already allows).

-- 1. plan_runs.trigger: a replan after a mastery shift (learning-engine §5.5) and after a manual edit of the plan.
alter table public.plan_runs drop constraint plan_runs_trigger_check;
alter table public.plan_runs add constraint plan_runs_trigger_check
  check (trigger in ('goal_created','exam_changed','scope_changed','day_missed','grade_logged','user_rebalance',
                     'nightly','availability_changed','material_added','desperate_on','desperate_off',
                     'mastery_shift','manual_edit'));

-- 2. knowledge_nodes.content_status: a topic the model refused is marked ai_refused, and the rest of the
--    material proceeds (spec 01 §7, ai-pipeline §1.4).
alter table public.knowledge_nodes drop constraint knowledge_nodes_content_status_check;
alter table public.knowledge_nodes add constraint knowledge_nodes_content_status_check
  check (content_status in ('pending','generating','ready','failed','skipped_excluded','ai_refused'));

-- 3. ai_usage: call-level fields the AI pipeline records for support and batch reconciliation (ai-pipeline §9.2).
--    All nullable: rows written before this migration keep null.
alter table public.ai_usage
  add column if not exists budget_class text,                      -- content | user | system
  add column if not exists mode text,                              -- sync | stream | batch
  add column if not exists attempt int check (attempt is null or attempt >= 1),
  add column if not exists error_code text,
  add column if not exists ttft_ms int check (ttft_ms is null or ttft_ms >= 0),
  add column if not exists batch_id text,
  add column if not exists custom_id text;
