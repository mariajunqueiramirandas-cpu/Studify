-- App admins have no AI budget (PLT-04): their calls reserve against no scope, so neither the daily user
-- limit, the Turma month nor the global month can refuse them, and their spend does not use up anyone
-- else's share of the global month. Their cost is still recorded per call in public.ai_usage.

create or replace function private.ai_budget_reserve(
  p_user uuid, p_class_group uuid, p_feature text, p_budget_class text, p_estimate_micro_usd bigint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_res   uuid := public.uuid_v7();
  v_tz    text;
  v_today date;
  v_month date;
  s       record;
  b       record;
begin
  if p_budget_class not in ('content','user','system') then
    raise exception 'invalid budget class %', p_budget_class using errcode = '22023';
  end if;
  if p_estimate_micro_usd is null or p_estimate_micro_usd < 0 then
    raise exception 'invalid estimate' using errcode = '22023';
  end if;
  if p_budget_class <> 'system' and p_user is null then
    raise exception 'user is required for budget class %', p_budget_class using errcode = '22023';
  end if;

  -- No limit for app admins: a reservation without scopes, which ai_budget_settle settles as a no-op.
  if exists (select 1 from public.profiles p where p.id = p_user and p.app_role = 'app_admin') then
    return v_res;
  end if;

  perform private.ai_budget_release_expired();

  select coalesce(p.timezone, 'America/Sao_Paulo') into v_tz from public.profiles p where p.id = p_user;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  v_today := (now() at time zone v_tz)::date;
  v_month := date_trunc('month', now() at time zone v_tz)::date;

  for s in
    select x.scope_type, x.scope_id, x.period_type, x.period_start
      from (
        select 'global'::text, '00000000-0000-0000-0000-000000000000'::uuid, 'month'::text, v_month
        union all
        select 'user'::text, p_user, 'day'::text, v_today
          where p_budget_class = 'user' or (p_budget_class = 'content' and p_class_group is null)
        union all
        select 'class_group'::text, p_class_group, 'month'::text, v_month
          where p_budget_class = 'content' and p_class_group is not null
      ) x(scope_type, scope_id, period_type, period_start)
     order by 1, 2
  loop
    insert into private.ai_budgets (scope_type, scope_id, period_type, period_start, limit_micro_usd)
    values (s.scope_type, s.scope_id, s.period_type, s.period_start,
            private.ai_budget_limit(s.scope_type, s.scope_id, s.period_type))
    on conflict do nothing;

    select * into b from private.ai_budgets
     where scope_type = s.scope_type and scope_id = s.scope_id
       and period_type = s.period_type and period_start = s.period_start
     for update;

    if b.spent_micro_usd + b.reserved_micro_usd + p_estimate_micro_usd > b.limit_micro_usd then
      raise exception 'budget_exhausted' using
        detail = s.scope_type,
        hint = 'resets_at=' || (case when s.period_type = 'day' then (s.period_start + 1)::text
                                     else (s.period_start + interval '1 month')::date::text end);
    end if;

    update private.ai_budgets set reserved_micro_usd = reserved_micro_usd + p_estimate_micro_usd, updated_at = now()
     where scope_type = s.scope_type and scope_id = s.scope_id
       and period_type = s.period_type and period_start = s.period_start;
    insert into private.ai_budget_reservations
      (reservation_id, scope_type, scope_id, period_type, period_start, amount_micro_usd)
    values (v_res, s.scope_type, s.scope_id, s.period_type, s.period_start, p_estimate_micro_usd);
  end loop;

  return v_res;
end $$;

-- The usage meter (Perfil → Uso de IA) shows an admin as 0% used: there is no limit to use up.
create or replace function public.my_ai_usage_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_tz    text;
  v_today date;
  v_limit bigint;
  v_spent bigint := 0;
  v_pct   int;
  v_by    jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  if exists (select 1 from public.profiles p where p.id = v_uid and p.app_role = 'app_admin') then
    return jsonb_build_object('pct', 0, 'byFeature', '[]'::jsonb);
  end if;

  select coalesce(p.timezone, 'America/Sao_Paulo') into v_tz from public.profiles p where p.id = v_uid;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  v_today := (now() at time zone v_tz)::date;

  select b.limit_micro_usd, b.spent_micro_usd into v_limit, v_spent
    from private.ai_budgets b
   where b.scope_type = 'user' and b.scope_id = v_uid and b.period_type = 'day' and b.period_start = v_today;
  if not found then
    v_limit := private.ai_budget_limit('user', v_uid, 'day');
    v_spent := 0;
  end if;

  v_pct := case when coalesce(v_limit, 0) > 0
                then least(100, round(v_spent * 100.0 / v_limit))::int else 100 end;

  select coalesce(jsonb_agg(jsonb_build_object('feature', x.feature, 'pct', x.pct) order by x.feature), '[]'::jsonb)
    into v_by
    from (select u.feature,
                 case when coalesce(v_limit, 0) > 0
                      then least(100, round(sum(u.cost_micro_usd) * 100.0 / v_limit))::int else 100 end as pct
            from public.ai_usage u
           where u.user_id = v_uid
             and (u.created_at at time zone v_tz)::date = v_today
           group by u.feature) x;

  return jsonb_build_object('pct', v_pct, 'byFeature', v_by);
end $$;
