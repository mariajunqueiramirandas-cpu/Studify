-- Phase 2 RPCs (docs/engineering/api.md §5): class_insights_for (SOC-04), apply_schedule_import (ING-07),
-- block_user replacement (SOC-X.3, SOC-02.11), my_ai_usage_today (PLT-04). Also feed items become
-- flaggable and hideable (TRU-02.1) by extending private.item_scope.
-- Errors: errcode P0001, HINT = the api.md §11 code (message is a short English description).

-- ---------------------------------------------------------------------
-- TRU-02: feed items join the R19 item types (item_scope was written before feed_items existed).
-- ---------------------------------------------------------------------
create or replace function private.item_scope(p_type text, p_id uuid)
returns table (subj uuid, personal uuid)
language sql stable security definer set search_path = '' as $$
  select n.subject_id, null::uuid from public.knowledge_nodes n where p_type = 'knowledge_node' and n.id = p_id
  union all
  select c.subject_id, c.personal_for_user_id from public.cards c where p_type = 'card' and c.id = p_id
  union all
  select q.subject_id, q.personal_for_user_id from public.questions q where p_type = 'question' and q.id = p_id
  union all
  select g.subject_id, null::uuid from public.glossary_terms g where p_type = 'glossary_term' and g.id = p_id
  union all
  select nt.subject_id, null::uuid from public.notes nt where p_type = 'note' and nt.id = p_id
  union all
  select e.subject_id, e.personal_for_user_id from public.explanations e where p_type = 'explanation' and e.id = p_id
  union all
  select d.subject_id, null::uuid from public.documents d where p_type = 'document' and d.id = p_id
  union all
  select f.subject_id, f.personal_for_user_id from public.feed_items f where p_type = 'feed_item' and f.id = p_id
  union all
  select null::uuid, th.user_id from public.tutor_messages m
    join public.tutor_threads th on th.id = m.thread_id
   where p_type = 'tutor_message' and m.id = p_id
$$;

-- ---------------------------------------------------------------------
-- SOC-04 class_insights_for. Aggregates are computed here, from each member's first answer to a question,
-- and only members who contribute (contribute_insights, SOC-04.6) and are active are counted.
-- Thresholds (spec 10 §8.4, learning-engine §18.3), applied in SQL:
--   n < 5                              nothing
--   5 <= n < 10 or min(c, w) < 2       band only: wrong >= 60% "dificil", <= 20% "tranquila", else nothing
--   n >= 10 and min(c, w) >= 2         wrong rate rounded to 5%, clamped to [5, 95]
--   wrong option ("pegadinha")         only if n >= 10 and chosen by >= 3 people; share rounded to 5%
--   topic (node) aggregate             mean wrong rate of the topic's questions with n >= 5, only if >= 3 such
-- Output: [{question_id, node_id, pct_wrong, band, n_bucket, option_pcts}], never user ids. Rows are
-- question rows (question_id set) and topic rows (question_id null). Members and their answers are not listed.
-- ---------------------------------------------------------------------
create or replace function public.class_insights_for(
  p_class_group_id uuid,
  p_subject_id     uuid default null,
  p_node_id        uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.is_member(p_class_group_id) then
    raise exception 'not a member' using errcode = 'P0001', hint = 'not_member';
  end if;
  if p_subject_id is not null and not exists (
       select 1 from public.subjects s
        where s.id = p_subject_id and s.owner_class_group_id = p_class_group_id and s.deleted_at is null) then
    raise exception 'subject not found' using errcode = 'P0001', hint = 'not_found';
  end if;
  if p_node_id is not null and not exists (
       select 1 from public.knowledge_nodes n
         join public.subjects s on s.id = n.subject_id
        where n.id = p_node_id and s.owner_class_group_id = p_class_group_id and n.deleted_at is null) then
    raise exception 'node not found' using errcode = 'P0001', hint = 'not_found';
  end if;

  with answers as (
    select distinct on (aa.user_id, aa.question_id)
           aa.question_id, q.node_id, aa.correct, aa.response->>'choice' as choice
      from public.attempt_answers aa
      join public.class_group_members m
        on m.user_id = aa.user_id and m.class_group_id = p_class_group_id
       and m.status = 'active' and m.contribute_insights
      join public.questions q on q.id = aa.question_id
      join public.subjects s on s.id = q.subject_id
     where s.owner_class_group_id = p_class_group_id and s.deleted_at is null
       and q.status = 'active' and q.deleted_at is null and q.hidden_reason is null
       and q.personal_for_user_id is null
       and (p_subject_id is null or s.id = p_subject_id)
       and (p_node_id is null or q.node_id = p_node_id)
       and aa.correct is not null and aa.deleted_at is null
     order by aa.user_id, aa.question_id, aa.answered_at, aa.id
  ),
  per_q as (
    select a.question_id, a.node_id, count(*) as n, count(*) filter (where not a.correct) as w
      from answers a
     group by a.question_id, a.node_id
  ),
  scored as (
    select p.question_id, p.node_id, p.n, p.w,
           p.w * 100.0 / p.n as rate,
           (p.n >= 10 and least(p.w, p.n - p.w) >= 2) as exact
      from per_q p
     where p.n >= 5
  ),
  picks as (
    select a.question_id, a.choice, count(*) as c
      from answers a
     where not a.correct and a.choice is not null
     group by a.question_id, a.choice
    having count(*) >= 3
  ),
  question_rows as (
    select s.question_id, s.node_id, s.exact, s.n, s.rate,
           case when s.exact then greatest(5, least(95, round(s.rate / 5) * 5))::int end as pct_wrong,
           case when not s.exact and s.rate >= 60 then 'dificil'
                when not s.exact and s.rate <= 20 then 'tranquila' end as band,
           case when s.n >= 10 then '10+' else '5-9' end as n_bucket,
           case when s.n >= 10 then (select jsonb_object_agg(k.choice, (round(k.c * 100.0 / s.n / 5) * 5)::int)
                                       from picks k where k.question_id = s.question_id) end as option_pcts
      from scored s
  ),
  topic_rows as (
    select s.node_id,
           greatest(5, least(95, round(avg(s.rate) / 5) * 5))::int as pct_wrong,
           sum(s.n) as n_total
      from scored s
     where s.node_id is not null
     group by s.node_id
    having count(*) >= 3
  )
  select coalesce(jsonb_agg(x.row_json order by x.sort_node, x.sort_question), '[]'::jsonb) into v_out
    from (
      select jsonb_build_object('question_id', qr.question_id, 'node_id', qr.node_id, 'pct_wrong', qr.pct_wrong,
                                'band', qr.band, 'n_bucket', qr.n_bucket, 'option_pcts', qr.option_pcts) as row_json,
             qr.node_id::text as sort_node, qr.question_id::text as sort_question
        from question_rows qr
       where qr.exact or qr.band is not null
      union all
      select jsonb_build_object('question_id', null, 'node_id', tr.node_id, 'pct_wrong', tr.pct_wrong,
                                'band', null, 'n_bucket', case when tr.n_total >= 10 then '10+' else '5-9' end,
                                'option_pcts', null),
             tr.node_id::text, null
        from topic_rows tr
    ) x;

  return v_out;
end $$;

-- ---------------------------------------------------------------------
-- ING-07 apply_schedule_import. Creates the goal (exam_week) when none is given, then one draft exam per
-- extracted item (status = draft; spec 07 §7.4, GOL-02.6). The subject is matched by normalized name
-- (similarity >= 0.8, ING-07.4) among the subjects the caller can read; otherwise it stays null.
-- Errors: not_found (not the caller's import, or the goal is not theirs), invalid_state (not a draft),
-- invalid_request (empty or malformed items).
-- ---------------------------------------------------------------------
create or replace function public.apply_schedule_import(p_schedule_import_id uuid, p_goal_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_si    public.schedule_imports%rowtype;
  v_goal  uuid := p_goal_id;
  v_item  jsonb;
  v_subj  uuid;
  v_exam  uuid;
  v_ids   uuid[] := '{}';
  v_first date;
  v_last  date;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  select * into v_si from public.schedule_imports
   where id = p_schedule_import_id and user_id = v_uid for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_si.status <> 'draft' then
    raise exception 'schedule import is not a draft' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if jsonb_array_length(v_si.extracted) = 0 then
    raise exception 'nothing to apply' using errcode = 'P0001', hint = 'invalid_request';
  end if;
  for v_item in select e.value from jsonb_array_elements(v_si.extracted) e loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item->>'title', '') = '' or coalesce(v_item->>'local_date', '') = '' then
      raise exception 'invalid extracted item' using errcode = 'P0001', hint = 'invalid_request';
    end if;
  end loop;

  select min((e.value->>'local_date')::date), max((e.value->>'local_date')::date) into v_first, v_last
    from jsonb_array_elements(v_si.extracted) e;

  if v_goal is null then
    v_goal := public.uuid_v7();
    insert into public.goals (id, user_id, mode, name, start_date, end_date)
    values (v_goal, v_uid, 'exam_week', 'Semana de Provas', v_first, v_last);
  elsif not exists (select 1 from public.goals g where g.id = v_goal and g.user_id = v_uid and g.deleted_at is null) then
    raise exception 'goal not found' using errcode = 'P0001', hint = 'not_found';
  end if;

  for v_item in select e.value from jsonb_array_elements(v_si.extracted) e loop
    v_subj := null;
    if coalesce(v_item->>'subject_name', '') <> '' then
      select s.id into v_subj from public.subjects s
       where s.deleted_at is null and private.can_read_subject(s.id)
         and public.similarity(lower(private.f_unaccent(s.name)), lower(private.f_unaccent(v_item->>'subject_name'))) >= 0.8
       order by public.similarity(lower(private.f_unaccent(s.name)), lower(private.f_unaccent(v_item->>'subject_name'))) desc, s.id
       limit 1;
    end if;

    insert into public.exams (goal_id, user_id, subject_id, title, local_date, starts_at, status, kind)
    values (v_goal, v_uid, v_subj, v_item->>'title', (v_item->>'local_date')::date,
            nullif(v_item->>'starts_at', '')::timestamptz, 'draft', 'regular')
    returning id into v_exam;
    v_ids := v_ids || v_exam;
  end loop;

  update public.schedule_imports set status = 'applied', goal_id = v_goal where id = v_si.id;
  return jsonb_build_object('goal_id', v_goal, 'exam_ids', to_jsonb(v_ids));
end $$;

-- ---------------------------------------------------------------------
-- SOC-X.3 / SOC-02.11: blocking is mutual in effect and cancels the open duels between the pair (waiting_opponent).
-- Replaces the core version. Cancelled duels carry no XP penalty (SOC-02.10).
-- ---------------------------------------------------------------------
create or replace function public.block_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_user_id = v_uid then raise exception 'invalid target' using errcode = 'P0001', hint = 'invalid_request'; end if;

  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, p_user_id)
  on conflict do nothing;

  update public.duels set status = 'cancelled'
   where status = 'waiting_opponent'
     and ((challenger_id = v_uid and opponent_id = p_user_id)
          or (challenger_id = p_user_id and opponent_id = v_uid));
end $$;

-- ---------------------------------------------------------------------
-- PLT-04 my_ai_usage_today: the caller's share of today's AI limit (their local day). Percent only: the
-- budget row (private.ai_budgets) gives the total and the limit is private.ai_budget_limit when no row
-- exists yet; byFeature sums the caller's ai_usage rows of today. In-flight reservations are not counted.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Grants: RPCs for signed-in users (and the service role); the new helper functions for policies only.
-- ---------------------------------------------------------------------
revoke all on function public.class_insights_for(uuid, uuid, uuid) from public, anon;
grant execute on function public.class_insights_for(uuid, uuid, uuid) to authenticated, service_role;

revoke all on function public.apply_schedule_import(uuid, uuid) from public, anon;
grant execute on function public.apply_schedule_import(uuid, uuid) to authenticated, service_role;

revoke all on function public.block_user(uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated, service_role;

revoke all on function public.my_ai_usage_today() from public, anon;
grant execute on function public.my_ai_usage_today() to authenticated, service_role;

revoke all on function private.item_scope(text, uuid) from public, anon;
grant execute on function private.item_scope(text, uuid) to authenticated, service_role;
