-- Web dashboard (apps/dashboard, served by the API at /painel): configurable AI limits (PLT-04.6), the admin
-- audit log (security-privacy §12) and the read models of the Administração pages.
--
-- Everything here is service-only. The API reaches the private schema over its direct Postgres connection
-- (apps/api/src/shared/private-schema.ts) after requireAppAdmin; no function is callable by a signed-in client.
-- Money stays in micro-USD (data-model §1). Days are São Paulo days, as in public.class_group_ai_usage.

-- =====================================================================
-- Configurable AI limits (PLT-04.6)
-- =====================================================================
-- One row per configured limit. scope_id = the zero uuid is the default for every scope of that type; a user id
-- is an override for that student. Per-Turma overrides stay in class_groups.ai_budget_monthly_micro_usd.
-- Without a row, the Phase 0 placeholders apply (private.ai_budget_default).
create table private.ai_budget_limits (                     -- [svc] PLT-04.6
  scope_type      text not null check (scope_type in ('user','class_group','global')),
  scope_id        uuid not null,
  limit_micro_usd bigint not null check (limit_micro_usd >= 0),
  updated_by      uuid,                                       -- plain uuid: the row outlives the admin's profile
  updated_at      timestamptz not null default now(),
  primary key (scope_type, scope_id),
  check (scope_type = 'user' or scope_id = '00000000-0000-0000-0000-000000000000')
);
alter table private.ai_budget_limits enable row level security;
revoke all on private.ai_budget_limits from public, anon, authenticated;
grant all on private.ai_budget_limits to service_role;

-- The Phase 0 placeholders, now only the fallback when the owner has not set a limit.
create or replace function private.ai_budget_default(p_scope_type text) returns bigint
language sql immutable set search_path = '' as $$
  select case p_scope_type
           when 'user' then 1000000::bigint            -- $1.00 per user per day
           when 'class_group' then 50000000::bigint    -- $50 per Turma per month
           when 'global' then 100000000::bigint        -- $100 global per month
         end;
$$;

-- Same signature and callers as before; the limit now comes from the owner's settings.
-- user: the student's override, else the default. class_group: the Turma's own limit, else the default.
create or replace function private.ai_budget_limit(p_scope_type text, p_scope_id uuid, p_period_type text)
returns bigint
language plpgsql stable set search_path = '' as $$
declare
  v_zero  constant uuid := '00000000-0000-0000-0000-000000000000';
  v_limit bigint;
begin
  if p_scope_type = 'user' then
    select l.limit_micro_usd into v_limit from private.ai_budget_limits l
     where l.scope_type = 'user' and l.scope_id in (p_scope_id, v_zero)
     order by (l.scope_id = v_zero)
     limit 1;
  elsif p_scope_type = 'class_group' then
    select g.ai_budget_monthly_micro_usd into v_limit from public.class_groups g where g.id = p_scope_id;
    if v_limit is null then
      select l.limit_micro_usd into v_limit from private.ai_budget_limits l
       where l.scope_type = 'class_group' and l.scope_id = v_zero;
    end if;
  elsif p_scope_type = 'global' then
    select l.limit_micro_usd into v_limit from private.ai_budget_limits l
     where l.scope_type = 'global' and l.scope_id = v_zero;
  else
    raise exception 'unknown budget scope %', p_scope_type;
  end if;
  return coalesce(v_limit, private.ai_budget_default(p_scope_type));
end $$;

-- Sets one limit (p_limit null clears it) and applies it to the open periods at once. Budget rows copy their
-- limit when the period's first call creates them, so without the update a change would wait for the next day
-- or month. p_scope_id: the zero uuid for a default, a user id for a student, a class_groups id for a Turma.
-- Returns the limit that now applies to the scope.
create or replace function private.ai_budget_set_limit(p_scope_type text, p_scope_id uuid, p_limit bigint, p_actor uuid)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if p_scope_type is null or p_scope_type not in ('user','class_group','global') then
    raise exception 'unknown budget scope %', p_scope_type using errcode = '22023';
  end if;
  if p_scope_id is null or (p_scope_type = 'global' and p_scope_id <> v_zero) then
    raise exception 'invalid budget scope id' using errcode = '22023';
  end if;
  if p_limit is not null and p_limit < 0 then
    raise exception 'invalid limit' using errcode = '22023';
  end if;

  if p_scope_type = 'class_group' and p_scope_id <> v_zero then
    update public.class_groups set ai_budget_monthly_micro_usd = p_limit where id = p_scope_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  elsif p_limit is null then
    delete from private.ai_budget_limits where scope_type = p_scope_type and scope_id = p_scope_id;
  else
    insert into private.ai_budget_limits (scope_type, scope_id, limit_micro_usd, updated_by)
    values (p_scope_type, p_scope_id, p_limit, p_actor)
    on conflict (scope_type, scope_id) do update
      set limit_micro_usd = excluded.limit_micro_usd, updated_by = excluded.updated_by, updated_at = now();
  end if;

  -- Yesterday is included: a student west of UTC can still be in it.
  update private.ai_budgets b
     set limit_micro_usd = private.ai_budget_limit(b.scope_type, b.scope_id, b.period_type), updated_at = now()
   where b.scope_type = p_scope_type
     and (p_scope_id = v_zero or b.scope_id = p_scope_id)
     and b.period_start >= case when b.period_type = 'day' then current_date - 1
                                else date_trunc('month', current_date - 1)::date end;

  return private.ai_budget_limit(p_scope_type, p_scope_id, case when p_scope_type = 'user' then 'day' else 'month' end);
end $$;

-- The three defaults with where each comes from, and how many students have their own limit.
create or replace function private.admin_limits() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_day', jsonb_build_object(
      'effective', private.ai_budget_limit('user', '00000000-0000-0000-0000-000000000000', 'day'),
      'configured', (select l.limit_micro_usd from private.ai_budget_limits l
                      where l.scope_type = 'user' and l.scope_id = '00000000-0000-0000-0000-000000000000'),
      'builtin', private.ai_budget_default('user')),
    'class_group_month', jsonb_build_object(
      'effective', private.ai_budget_limit('class_group', '00000000-0000-0000-0000-000000000000', 'month'),
      'configured', (select l.limit_micro_usd from private.ai_budget_limits l
                      where l.scope_type = 'class_group' and l.scope_id = '00000000-0000-0000-0000-000000000000'),
      'builtin', private.ai_budget_default('class_group')),
    'global_month', jsonb_build_object(
      'effective', private.ai_budget_limit('global', '00000000-0000-0000-0000-000000000000', 'month'),
      'configured', (select l.limit_micro_usd from private.ai_budget_limits l
                      where l.scope_type = 'global' and l.scope_id = '00000000-0000-0000-0000-000000000000'),
      'builtin', private.ai_budget_default('global')),
    'user_overrides', (select count(*) from private.ai_budget_limits l
                        where l.scope_type = 'user' and l.scope_id <> '00000000-0000-0000-0000-000000000000'));
$$;

-- =====================================================================
-- Admin audit log (security-privacy §12: role changes, account actions, limits, flags, invites)
-- =====================================================================
create table private.admin_audit (                          -- [append] [svc] retained >= 5 years
  id          uuid primary key default public.uuid_v7(),
  actor_id    uuid,                                           -- plain uuid: the log outlives the admin's profile
  action      text not null check (char_length(action) between 1 and 60),
  target_type text not null check (char_length(target_type) between 1 and 40),
  target_id   text check (char_length(target_id) <= 120),     -- a uuid, a flag key or a version code
  details     jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at  timestamptz not null default now()
);
create index admin_audit_created on private.admin_audit (created_at desc);
alter table private.admin_audit enable row level security;
revoke all on private.admin_audit from public, anon, authenticated;
grant all on private.admin_audit to service_role;
create trigger admin_audit_append_only before update or delete on private.admin_audit
  for each row execute function private.forbid_mutation();

-- Admin reports scan ai_usage by time only; the existing indexes all lead with another column.
create index if not exists ai_usage_created on public.ai_usage (created_at);

-- =====================================================================
-- Read models of the Administração pages
-- =====================================================================

-- Under 18 by the protective rule of spec 00 §8.1 (birthday on the last day of the birth month).
create or replace function private.is_minor_birth(p_year int, p_month int) returns boolean
language sql stable set search_path = '' as $$
  select (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day' + interval '18 years')::date > current_date;
$$;

-- Visão geral: people, spend against the global cap, moderation queue and operations, in one call.
create or replace function private.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz          constant text := 'America/Sao_Paulo';
  v_zero        constant uuid := '00000000-0000-0000-0000-000000000000';
  v_today       date := (now() at time zone v_tz)::date;
  v_month       date := date_trunc('month', now() at time zone v_tz)::date;
  v_today_start timestamptz := v_today::timestamp at time zone v_tz;
  v_month_start timestamptz := v_month::timestamp at time zone v_tz;
  v_users       jsonb;
  v_series      jsonb;
  v_spend       jsonb;
  v_moderation  jsonb;
  v_ops         jsonb;
begin
  select jsonb_build_object(
           'total', count(*),
           'new_7d', count(*) filter (where p.created_at >= now() - interval '7 days'),
           'admins', count(*) filter (where p.app_role = 'app_admin'),
           'pending_names', count(*) filter (where p.display_name_status = 'pending'),
           'suspended', count(*) filter (where u.banned_until > now()),
           'active_7d', (select count(distinct x.user_id) from (
                           select a.user_id from public.daily_activity a
                            where a.local_date > v_today - 7 and a.deleted_at is null
                              and (a.active_minutes > 0 or a.reviews > 0 or a.questions > 0 or a.sessions > 0)
                           union
                           select g.user_id from public.ai_usage g
                            where g.created_at >= now() - interval '7 days' and g.user_id is not null) x
                          join public.profiles q on q.id = x.user_id and q.deleted_at is null))
    into v_users
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.deleted_at is null;

  -- Last 30 days, one entry per day (zeros included): AI cost and calls, sign-ups, students who studied.
  select jsonb_agg(jsonb_build_object(
           'day', d.day,
           'cost', coalesce(s.cost, 0),
           'calls', coalesce(s.calls, 0),
           'signups', coalesce(n.signups, 0),
           'active', coalesce(a.active, 0)) order by d.day)
    into v_series
    from (select generate_series(v_today - 29, v_today, interval '1 day')::date as day) d
    left join (select (g.created_at at time zone v_tz)::date as day, sum(g.cost_micro_usd)::bigint as cost, count(*) as calls
                 from public.ai_usage g
                where g.created_at >= (v_today - 29)::timestamp at time zone v_tz
                group by 1) s on s.day = d.day
    left join (select (p.created_at at time zone v_tz)::date as day, count(*) as signups
                 from public.profiles p
                where p.created_at >= (v_today - 29)::timestamp at time zone v_tz
                group by 1) n on n.day = d.day
    left join (select a.local_date as day, count(*) as active
                 from public.daily_activity a
                where a.local_date > v_today - 30 and a.deleted_at is null
                  and (a.active_minutes > 0 or a.reviews > 0 or a.questions > 0 or a.sessions > 0)
                group by 1) a on a.day = d.day;

  select jsonb_build_object(
           'today', (select coalesce(sum(g.cost_micro_usd), 0) from public.ai_usage g where g.created_at >= v_today_start),
           'month', (select coalesce(sum(g.cost_micro_usd), 0) from public.ai_usage g where g.created_at >= v_month_start),
           -- What the gate counts (admins are exempt, so this can be lower than `month`).
           'cap_used', (select coalesce(b.spent_micro_usd + b.reserved_micro_usd, 0) from private.ai_budgets b
                         where b.scope_type = 'global' and b.scope_id = v_zero
                           and b.period_type = 'month' and b.period_start = v_month),
           'cap', private.ai_budget_limit('global', v_zero, 'month'),
           'month_start', v_month,
           'today_date', v_today,
           'top_features', coalesce((select jsonb_agg(f order by f.cost desc) from (
               select g.feature, sum(g.cost_micro_usd)::bigint as cost, count(*) as calls
                 from public.ai_usage g where g.created_at >= v_month_start
                group by g.feature order by 2 desc limit 8) f), '[]'::jsonb),
           'top_class_groups', coalesce((select jsonb_agg(t order by t.cost desc) from (
               select g.class_group_id as id, c.name, sum(g.cost_micro_usd)::bigint as cost, count(*) as calls
                 from public.ai_usage g join public.class_groups c on c.id = g.class_group_id
                where g.created_at >= v_month_start
                group by g.class_group_id, c.name order by 3 desc limit 5) t), '[]'::jsonb),
           -- PLT-04.6 alert: students over 5x the median daily spend (only with at least 3 spenders today).
           'outliers_today', coalesce((
               with per_user as (
                 select g.user_id, sum(g.cost_micro_usd)::bigint as cost
                   from public.ai_usage g
                  where g.created_at >= v_today_start and g.user_id is not null
                  group by g.user_id),
               med as (select percentile_cont(0.5) within group (order by cost) as m, count(*) as n from per_user)
               select jsonb_agg(jsonb_build_object('id', pu.user_id, 'display_name', p.display_name, 'cost', pu.cost,
                                                   'median', round(med.m)) order by pu.cost desc)
                 from per_user pu cross join med
                 join public.profiles p on p.id = pu.user_id
                where med.n >= 3 and pu.cost > 5 * med.m), '[]'::jsonb))
    into v_spend;

  select jsonb_build_object(
           'open_reports', (select count(*) from public.user_reports r where r.status = 'open'),
           'escalated_reports', (select count(*) from public.user_reports r where r.status = 'escalated'),
           'open_flags', (select count(*) from public.content_flags f where f.status in ('open','triaged','hidden_pending')),
           'pending_names', (select count(*) from public.profiles p where p.display_name_status = 'pending' and p.deleted_at is null),
           'feedback_7d', (select count(*) from public.app_feedback f where f.created_at >= now() - interval '7 days'))
    into v_moderation;

  select jsonb_build_object(
           'failed_jobs_24h', (select count(*) from public.ai_jobs j where j.status = 'failed' and j.updated_at >= now() - interval '24 hours'),
           'running_jobs', (select count(*) from public.ai_jobs j where j.status in ('queued','running','waiting_batch')),
           'waiting_budget_jobs', (select count(*) from public.ai_jobs j where j.status = 'waiting_budget'),
           'pending_deletions', (select count(*) from public.account_deletions d where d.status in ('pending','running')),
           'failed_deletions', (select count(*) from public.account_deletions d where d.status = 'failed'),
           'open_exports', (select count(*) from public.data_exports e where e.status in ('queued','running')),
           'recent_failures', coalesce((select jsonb_agg(x order by x.updated_at desc) from (
               select j.id, j.type, j.stage, j.error_code, j.user_id, p.display_name, j.updated_at
                 from public.ai_jobs j left join public.profiles p on p.id = j.user_id
                where j.status = 'failed'
                order by j.updated_at desc limit 8) x), '[]'::jsonb))
    into v_ops;

  return jsonb_build_object('users', v_users, 'series', v_series, 'spend', v_spend,
                            'moderation', v_moderation, 'ops', v_ops, 'generated_at', now());
end $$;

-- Uso de IA: the owner dashboard of ai-pipeline §11 for the last p_days São Paulo days (1–366).
create or replace function private.admin_ai_report(p_days int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz    constant text := 'America/Sao_Paulo';
  v_days  int := least(366, greatest(1, coalesce(p_days, 30)));
  v_today date := (now() at time zone v_tz)::date;
  v_from  date := v_today - (least(366, greatest(1, coalesce(p_days, 30))) - 1);
  v_start timestamptz := v_from::timestamp at time zone v_tz;
  v_out   jsonb;
begin
  with u as (
    select g.*, coalesce(g.fallback_model, g.model) as served_model,
           (g.stop_reason = 'refusal' or g.refusal_category is not null) as refused
      from public.ai_usage g
     where g.created_at >= v_start
  )
  select jsonb_build_object(
    'days', v_days,
    'from', v_from,
    'to', v_today,
    'totals', (select jsonb_build_object(
                 'cost', coalesce(sum(cost_micro_usd), 0),
                 'calls', count(*),
                 'input_tokens', coalesce(sum(input_tokens), 0),
                 'output_tokens', coalesce(sum(output_tokens), 0),
                 'cache_read_tokens', coalesce(sum(cache_read_input_tokens), 0),
                 'cache_write_tokens', coalesce(sum(cache_creation_input_tokens), 0),
                 'refusals', count(*) filter (where refused),
                 'fallbacks', count(*) filter (where fallback_model is not null),
                 'batch_calls', count(*) filter (where batch),
                 'users', count(distinct user_id),
                 'p50_ms', percentile_disc(0.5) within group (order by latency_ms),
                 'p95_ms', percentile_disc(0.95) within group (order by latency_ms))
               from u),
    'by_day', (select jsonb_agg(jsonb_build_object('day', d.day, 'cost', coalesce(s.cost, 0), 'calls', coalesce(s.calls, 0))
                                order by d.day)
                 from (select generate_series(v_from, v_today, interval '1 day')::date as day) d
                 left join (select (created_at at time zone v_tz)::date as day, sum(cost_micro_usd)::bigint as cost, count(*) as calls
                              from u group by 1) s on s.day = d.day),
    'by_feature', coalesce((select jsonb_agg(f order by f.cost desc) from (
                   select feature, sum(cost_micro_usd)::bigint as cost, count(*) as calls,
                          count(*) filter (where refused) as refusals,
                          percentile_disc(0.5) within group (order by latency_ms) as p50_ms,
                          percentile_disc(0.95) within group (order by latency_ms) as p95_ms,
                          round(coalesce(sum(cache_read_input_tokens), 0)::numeric
                                / nullif(sum(cache_read_input_tokens + cache_creation_input_tokens + input_tokens), 0), 3) as cache_ratio
                     from u group by feature) f), '[]'::jsonb),
    'by_task', coalesce((select jsonb_agg(t order by t.cost desc) from (
                   select task, feature, sum(cost_micro_usd)::bigint as cost, count(*) as calls,
                          percentile_disc(0.5) within group (order by latency_ms) as p50_ms,
                          percentile_disc(0.95) within group (order by latency_ms) as p95_ms
                     from u group by task, feature order by 3 desc limit 15) t), '[]'::jsonb),
    'by_model', coalesce((select jsonb_agg(m order by m.cost desc) from (
                   select served_model as model, sum(cost_micro_usd)::bigint as cost, count(*) as calls
                     from u group by served_model) m), '[]'::jsonb),
    'by_class_group', coalesce((select jsonb_agg(c order by c.cost desc) from (
                   select u.class_group_id as id, coalesce(g.name, 'Turma excluída') as name,
                          sum(u.cost_micro_usd)::bigint as cost, count(*) as calls
                     from u left join public.class_groups g on g.id = u.class_group_id
                    where u.class_group_id is not null
                    group by u.class_group_id, g.name order by 3 desc limit 10) c), '[]'::jsonb),
    'personal_cost', (select coalesce(sum(cost_micro_usd), 0) from u where class_group_id is null),
    'top_users', coalesce((select jsonb_agg(x order by x.cost desc) from (
                   select u.user_id as id, p.display_name, p.app_role, sum(u.cost_micro_usd)::bigint as cost, count(*) as calls
                     from u left join public.profiles p on p.id = u.user_id
                    where u.user_id is not null
                    group by u.user_id, p.display_name, p.app_role order by 4 desc limit 10) x), '[]'::jsonb),
    'refusals_by_category', coalesce((select jsonb_agg(r order by r.calls desc) from (
                   select coalesce(refusal_category, 'unknown') as category, count(*) as calls
                     from u where refused group by 1) r), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;

-- Usuários: search by name, e-mail or id, with a filter; newest first. Returns { total, rows }.
create or replace function private.admin_users(p_query text, p_filter text, p_limit int, p_offset int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q      text := nullif(btrim(coalesce(p_query, '')), '');
  v_like   text;
  v_filter text := coalesce(p_filter, 'all');
  v_limit  int := least(100, greatest(1, coalesce(p_limit, 25)));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_total  bigint;
  v_rows   jsonb;
begin
  if v_filter not in ('all','admins','pending_names','suspended','minors','deleting') then
    raise exception 'unknown filter %', v_filter using errcode = '22023';
  end if;
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with matched as (
    select p.id, p.display_name, p.display_name_status, p.app_role, p.school_year, p.created_at, p.deleted_at,
           p.birth_year, p.birth_month, u.email, u.last_sign_in_at, u.banned_until
      from public.profiles p
      left join auth.users u on u.id = p.id
     where (v_q is null or p.display_name ilike v_like or u.email ilike v_like or p.id::text = lower(v_q))
       and case v_filter
             when 'admins' then p.app_role = 'app_admin'
             when 'pending_names' then p.display_name_status = 'pending' and p.deleted_at is null
             when 'suspended' then coalesce(u.banned_until > now(), false)
             when 'minors' then private.is_minor_birth(p.birth_year, p.birth_month) and p.deleted_at is null
             when 'deleting' then exists (select 1 from public.account_deletions d
                                           where d.user_id = p.id and d.status in ('pending','running','failed'))
             else true
           end
  ), page as (
    select * from matched order by created_at desc, id limit v_limit offset v_offset
  )
  select (select count(*) from matched),
         coalesce((select jsonb_agg(jsonb_build_object(
             'id', x.id, 'display_name', x.display_name, 'display_name_status', x.display_name_status,
             'app_role', x.app_role, 'school_year', x.school_year, 'created_at', x.created_at, 'deleted_at', x.deleted_at,
             'email', x.email, 'last_sign_in_at', x.last_sign_in_at, 'banned_until', x.banned_until,
             'is_minor', private.is_minor_birth(x.birth_year, x.birth_month),
             'last_active_date', (select max(a.local_date) from public.daily_activity a
                                   where a.user_id = x.id and a.deleted_at is null
                                     and (a.active_minutes > 0 or a.reviews > 0 or a.questions > 0 or a.sessions > 0)),
             'cost_30d', (select coalesce(sum(g.cost_micro_usd), 0) from public.ai_usage g
                           where g.user_id = x.id and g.created_at >= now() - interval '30 days'),
             'class_groups', (select count(*) from public.class_group_members m where m.user_id = x.id and m.status = 'active'),
             'deletion_pending', exists (select 1 from public.account_deletions d
                                          where d.user_id = x.id and d.status in ('pending','running')))
             order by x.created_at desc, x.id) from page x), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end $$;

-- One student, everything the owner needs to help or act: profile, sign-in, Turmas, devices, AI spend and
-- limit, study activity, recent operations, reports, exports and deletion. Null when there is no profile.
-- Study content (notes, answers, tutor messages) is deliberately not included.
create or replace function private.admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz          constant text := 'America/Sao_Paulo';
  v_today       date := (now() at time zone v_tz)::date;
  v_today_start timestamptz := v_today::timestamp at time zone v_tz;
  v_p           public.profiles%rowtype;
  v_out         jsonb;
begin
  select * into v_p from public.profiles where id = p_user;
  if not found then return null; end if;

  select jsonb_build_object(
    'profile', jsonb_build_object(
       'id', v_p.id, 'display_name', v_p.display_name, 'display_name_status', v_p.display_name_status,
       'avatar_preset', v_p.avatar_preset, 'school_year', v_p.school_year, 'timezone', v_p.timezone,
       'app_role', v_p.app_role, 'birth_year', v_p.birth_year, 'birth_month', v_p.birth_month,
       'is_minor', private.is_minor_birth(v_p.birth_year, v_p.birth_month),
       'privacy_notice_version', v_p.privacy_notice_version, 'privacy_accepted_at', v_p.privacy_accepted_at,
       'onboarding_completed_at', v_p.onboarding_completed_at, 'created_at', v_p.created_at,
       'updated_at', v_p.updated_at, 'deleted_at', v_p.deleted_at),
    'auth', (select jsonb_build_object('email', u.email, 'created_at', u.created_at,
                                       'last_sign_in_at', u.last_sign_in_at, 'banned_until', u.banned_until)
               from auth.users u where u.id = p_user),
    'class_groups', coalesce((select jsonb_agg(jsonb_build_object(
                       'id', g.id, 'name', g.name, 'role', m.role, 'status', m.status, 'joined_at', m.joined_at)
                       order by m.joined_at desc nulls last)
                     from public.class_group_members m join public.class_groups g on g.id = m.class_group_id
                    where m.user_id = p_user and g.deleted_at is null), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
                  'device_id', t.device_id, 'platform', t.platform, 'app_version', t.app_version,
                  'last_seen_at', t.last_seen_at, 'invalidated_at', t.invalidated_at) order by t.last_seen_at desc)
                from public.push_tokens t where t.user_id = p_user), '[]'::jsonb),
    'spend', jsonb_build_object(
       'today', (select coalesce(sum(g.cost_micro_usd), 0) from public.ai_usage g
                  where g.user_id = p_user and g.created_at >= v_today_start),
       'd30', (select coalesce(sum(g.cost_micro_usd), 0) from public.ai_usage g
                where g.user_id = p_user and g.created_at >= now() - interval '30 days'),
       'by_day', (select jsonb_agg(jsonb_build_object('day', d.day, 'cost', coalesce(s.cost, 0)) order by d.day)
                    from (select generate_series(v_today - 29, v_today, interval '1 day')::date as day) d
                    left join (select (g.created_at at time zone v_tz)::date as day, sum(g.cost_micro_usd)::bigint as cost
                                 from public.ai_usage g
                                where g.user_id = p_user and g.created_at >= (v_today - 29)::timestamp at time zone v_tz
                                group by 1) s on s.day = d.day),
       'by_feature', coalesce((select jsonb_agg(f order by f.cost desc) from (
                       select g.feature, sum(g.cost_micro_usd)::bigint as cost, count(*) as calls
                         from public.ai_usage g
                        where g.user_id = p_user and g.created_at >= now() - interval '30 days'
                        group by g.feature) f), '[]'::jsonb)),
    'limit', jsonb_build_object(
       'effective', private.ai_budget_limit('user', p_user, 'day'),
       'override', (select l.limit_micro_usd from private.ai_budget_limits l
                     where l.scope_type = 'user' and l.scope_id = p_user),
       'exempt', v_p.app_role = 'app_admin'),
    'activity', jsonb_build_object(
       'streak', (select s.current_length from public.streaks s where s.user_id = p_user),
       'longest_streak', (select s.longest_length from public.streaks s where s.user_id = p_user),
       'last_active_date', (select max(a.local_date) from public.daily_activity a
                             where a.user_id = p_user and a.deleted_at is null
                               and (a.active_minutes > 0 or a.reviews > 0 or a.questions > 0 or a.sessions > 0)),
       'minutes_7d', (select coalesce(sum(a.active_minutes), 0) from public.daily_activity a
                       where a.user_id = p_user and a.local_date > v_today - 7 and a.deleted_at is null),
       'reviews_7d', (select coalesce(sum(a.reviews), 0) from public.daily_activity a
                       where a.user_id = p_user and a.local_date > v_today - 7 and a.deleted_at is null),
       'subjects', (select count(*) from public.subjects s where s.owner_profile_id = p_user and s.deleted_at is null),
       'documents', (select count(*) from public.documents d
                      where d.uploaded_by = p_user and d.deleted_at is null)),
    'jobs', coalesce((select jsonb_agg(x order by x.created_at desc) from (
               select j.id, j.type, j.stage, j.status, j.error_code, j.created_at, j.finished_at
                 from public.ai_jobs j where j.user_id = p_user order by j.created_at desc limit 10) x), '[]'::jsonb),
    'reports', jsonb_build_object(
       'made', (select count(*) from public.user_reports r where r.reporter_id = p_user),
       'received', (select count(*) from public.user_reports r where r.reported_id = p_user),
       'open_received', (select count(*) from public.user_reports r where r.reported_id = p_user and r.status in ('open','escalated'))),
    'exports', coalesce((select jsonb_agg(x order by x.created_at desc) from (
                  select e.id, e.status, e.created_at, e.completed_at, e.expires_at
                    from public.data_exports e where e.user_id = p_user order by e.created_at desc limit 5) x), '[]'::jsonb),
    'deletion', (select jsonb_build_object('id', d.id, 'status', d.status, 'requested_by', d.requested_by,
                                           'requested_at', d.requested_at, 'completed_at', d.completed_at)
                   from public.account_deletions d where d.user_id = p_user order by d.requested_at desc limit 1))
    into v_out;
  return v_out;
end $$;

-- Turmas: members, owner, this month's AI spend and the limit that applies.
create or replace function private.admin_class_groups() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz          constant text := 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() at time zone v_tz)::date::timestamp at time zone v_tz;
  v_out         jsonb;
begin
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v_out from (
    select g.id, g.name, g.school, g.school_year, g.join_policy, g.member_cap, g.allow_member_uploads, g.created_at,
           g.owner_id, p.display_name as owner_name,
           (select count(*) from public.class_group_members m where m.class_group_id = g.id and m.status = 'active') as members,
           (select count(*) from public.class_group_members m where m.class_group_id = g.id and m.status = 'pending') as pending,
           (select count(*) from public.subjects s where s.owner_class_group_id = g.id and s.deleted_at is null) as subjects,
           g.ai_budget_monthly_micro_usd as budget_override,
           private.ai_budget_limit('class_group', g.id, 'month') as budget_limit,
           (select coalesce(sum(u.cost_micro_usd), 0) from public.ai_usage u
             where u.class_group_id = g.id and u.created_at >= v_month_start) as cost_month,
           (select count(*) from public.user_reports r where r.class_group_id = g.id and r.status in ('open','escalated')) as open_reports
      from public.class_groups g
      left join public.profiles p on p.id = g.owner_id
     where g.deleted_at is null) x;
  return v_out;
end $$;

-- Moderação: the operator's queue (SP-09): open reports, flagged content, names waiting for review, feedback.
create or replace function private.admin_moderation() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'reports', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select r.id, r.reason, r.context_type, r.context_id, r.comment, r.status, r.created_at,
               r.class_group_id, g.name as class_group_name,
               r.reporter_id, rp.display_name as reporter_name,
               r.reported_id, dp.display_name as reported_name, dp.display_name_status as reported_name_status
          from public.user_reports r
          left join public.class_groups g on g.id = r.class_group_id
          left join public.profiles rp on rp.id = r.reporter_id
          left join public.profiles dp on dp.id = r.reported_id
         where r.status in ('open','escalated')
         order by r.created_at desc limit 100) x), '[]'::jsonb),
    'flags', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select f.id, f.item_type, f.item_id, f.reason, f.comment, f.status, f.created_at,
               f.ai_verdict, f.ai_confidence, f.ai_explanation,
               f.class_group_id, g.name as class_group_name, f.reporter_id, rp.display_name as reporter_name
          from public.content_flags f
          left join public.class_groups g on g.id = f.class_group_id
          left join public.profiles rp on rp.id = f.reporter_id
         where f.status in ('open','triaged','hidden_pending')
         order by f.created_at desc limit 100) x), '[]'::jsonb),
    'pending_names', coalesce((select jsonb_agg(x order by x.updated_at) from (
        select p.id, p.display_name, p.created_at, p.updated_at
          from public.profiles p
         where p.display_name_status = 'pending' and p.deleted_at is null
         order by p.updated_at limit 200) x), '[]'::jsonb),
    'feedback', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select f.id, f.text, f.app_version, f.device_model, f.created_at, f.user_id, p.display_name
          from public.app_feedback f left join public.profiles p on p.id = f.user_id
         order by f.created_at desc limit 50) x), '[]'::jsonb));
$$;

-- Registro: newest first, with the actor's name; p_before pages back, p_target narrows to one target.
create or replace function private.admin_audit_list(p_limit int, p_before timestamptz, p_target text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, a.actor_id, p.display_name as actor_name
      from private.admin_audit a
      left join public.profiles p on p.id = a.actor_id
     where (p_before is null or a.created_at < p_before)
       and (p_target is null or a.target_id = p_target)
     order by a.created_at desc
     limit least(200, greatest(1, coalesce(p_limit, 50)))) x;
$$;

-- =====================================================================
-- Grants: service role only (the final block of core_rpc.sql gives most private functions to
-- `authenticated`; none of these may be reachable by a signed-in client).
-- =====================================================================
revoke all on function private.ai_budget_default(text) from public, anon, authenticated;
revoke all on function private.ai_budget_set_limit(text, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function private.admin_limits() from public, anon, authenticated;
revoke all on function private.is_minor_birth(int, int) from public, anon, authenticated;
revoke all on function private.admin_overview() from public, anon, authenticated;
revoke all on function private.admin_ai_report(int) from public, anon, authenticated;
revoke all on function private.admin_users(text, text, int, int) from public, anon, authenticated;
revoke all on function private.admin_user_detail(uuid) from public, anon, authenticated;
revoke all on function private.admin_class_groups() from public, anon, authenticated;
revoke all on function private.admin_moderation() from public, anon, authenticated;
revoke all on function private.admin_audit_list(int, timestamptz, text) from public, anon, authenticated;
grant execute on function private.ai_budget_default(text) to service_role;
grant execute on function private.ai_budget_set_limit(text, uuid, bigint, uuid) to service_role;
grant execute on function private.admin_limits() to service_role;
grant execute on function private.is_minor_birth(int, int) to service_role;
grant execute on function private.admin_overview() to service_role;
grant execute on function private.admin_ai_report(int) to service_role;
grant execute on function private.admin_users(text, text, int, int) to service_role;
grant execute on function private.admin_user_detail(uuid) to service_role;
grant execute on function private.admin_class_groups() to service_role;
grant execute on function private.admin_moderation() to service_role;
grant execute on function private.admin_audit_list(int, timestamptz, text) to service_role;
