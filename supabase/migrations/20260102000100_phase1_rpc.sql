-- Phase 1 RPCs (docs/engineering/api.md §5) and replacements of core RPCs that were left unsupported:
-- edit_outline (merge, split, restore; ING-04), undo_outline_event (for those ops), join_class_group
-- (SOC-01.14 rate limit), handle_report (remove_content). New: confirm_exam_scope, log_exam_grade,
-- start/set/end_desperate_mode (GOL-03, GOL-06, GOL-12), resolve_flag (TRU-02).
-- Errors: errcode P0001, HINT = the api.md §11 code (message is a short English description).

-- ---------------------------------------------------------------------
-- Join rate limit (SOC-01.14): 5 failed codes per user per hour.
-- A function that raises cannot also persist its failure (the raise rolls the write back), so the
-- failure row is written by record_join_failure, which the join-class Edge Function calls with the
-- service role after join_class_group answers invite_invalid / invite_expired / invite_used_up.
-- ---------------------------------------------------------------------
create table private.join_attempts (
  id           uuid primary key default public.uuid_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_time on private.join_attempts (user_id, attempted_at);
alter table private.join_attempts enable row level security;
revoke all on private.join_attempts from public, anon, authenticated;
grant all on private.join_attempts to service_role;

create or replace function public.record_join_failure(p_user_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into private.join_attempts (user_id) values (p_user_id);
$$;

-- Same behaviour as the core version, plus the rate limit at the top.
create or replace function public.join_class_group(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_inv    public.invites%rowtype;
  v_group  public.class_groups%rowtype;
  v_member public.class_group_members%rowtype;
  v_active int;
  v_status text;
  v_email  text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  if (select count(*) from private.join_attempts a
       where a.user_id = v_uid and a.attempted_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate limited' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  select * into v_inv from public.invites
   where code = upper(btrim(p_code)) and class_group_id is not null;
  if not found or v_inv.revoked_at is not null then raise exception 'invite_invalid'; end if;
  if v_inv.expires_at <= now() then raise exception 'invite_expired'; end if;
  if v_inv.uses_left is not null and v_inv.uses_left <= 0 then raise exception 'invite_used_up'; end if;
  if v_inv.email is not null then
    select lower(u.email) into v_email from auth.users u where u.id = v_uid;
    if v_email is distinct from lower(v_inv.email::text) then raise exception 'invite_invalid'; end if;
  end if;

  select * into v_group from public.class_groups where id = v_inv.class_group_id and deleted_at is null;
  if not found then raise exception 'invite_invalid'; end if;

  select * into v_member from public.class_group_members
   where class_group_id = v_group.id and user_id = v_uid;
  if found then
    if v_member.status = 'banned' then raise exception 'banned'; end if;
    if v_member.status in ('active','pending') then
      return jsonb_build_object('class_group_id', v_group.id, 'status', v_member.status);
    end if;
  end if;

  select count(*) into v_active from public.class_group_members
   where class_group_id = v_group.id and status = 'active';
  if v_active >= v_group.member_cap then raise exception 'class_full'; end if;

  v_status := case when v_group.join_policy = 'open' then 'active' else 'pending' end;
  insert into public.class_group_members (class_group_id, user_id, role, status, joined_at)
  values (v_group.id, v_uid, 'member', v_status, case when v_status = 'active' then now() end)
  on conflict (class_group_id, user_id) do update
    set status = excluded.status, role = 'member', joined_at = excluded.joined_at,
        left_at = null, approved_by = null;

  if v_inv.uses_left is not null then
    update public.invites set uses_left = uses_left - 1 where id = v_inv.id;
  end if;
  return jsonb_build_object('class_group_id', v_group.id, 'status', v_status);
end $$;

-- ---------------------------------------------------------------------
-- Item helpers (TRU-02, SP-09). Service-internal: called from the RPCs below, never directly.
-- ---------------------------------------------------------------------

-- True when the item's subject is owned by the Turma (moderators act only inside their own Turma).
create or replace function private.item_belongs_to_group(p_type text, p_id uuid, p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.item_scope(p_type, p_id) s
                 join public.subjects sub on sub.id = s.subj
                 where sub.owner_class_group_id = p_group);
$$;

-- Sets hidden_reason on the item types that have one. p_only_under_review: only lifts an
-- 'under_review' hold (used when a flag is closed). Raises when the type cannot be hidden.
create or replace function private.hide_item(p_type text, p_id uuid, p_reason text, p_only_under_review boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_n int := 0;
begin
  case p_type
    when 'knowledge_node' then
      update public.knowledge_nodes set hidden_reason = p_reason
       where id = p_id and (not p_only_under_review or hidden_reason = 'under_review');
    when 'card' then
      update public.cards set hidden_reason = p_reason
       where id = p_id and (not p_only_under_review or hidden_reason = 'under_review');
    when 'question' then
      update public.questions set hidden_reason = p_reason
       where id = p_id and (not p_only_under_review or hidden_reason = 'under_review');
    when 'glossary_term' then
      update public.glossary_terms set hidden_reason = p_reason
       where id = p_id and (not p_only_under_review or hidden_reason = 'under_review');
    else
      raise exception 'item type cannot be hidden' using errcode = 'P0001', hint = 'invalid_request';
  end case;
  get diagnostics v_n = row_count;
  if v_n = 0 and not p_only_under_review then
    raise exception 'item not found' using errcode = 'P0001', hint = 'not_found';
  end if;
end $$;

-- Applies a TRU-02 fix to the item: whitelisted columns only, version bumped, snapshot in item_revisions.
-- Returns answer_changed (the answer key changed: the worker re-scores affected attempts).
create or replace function private.apply_item_fix(p_type text, p_id uuid, p_fix jsonb, p_flag uuid, p_uid uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_ver  int;
  v_snap jsonb;
  v_changed boolean := false;
begin
  if jsonb_typeof(p_fix) <> 'object' then
    raise exception 'fix must be an object' using errcode = 'P0001', hint = 'invalid_request';
  end if;

  if p_type = 'card' then
    update public.cards t
       set front = coalesce(p_fix->>'front', t.front), back = coalesce(p_fix->>'back', t.back),
           version = t.version + 1
     where t.id = p_id
    returning t.version, to_jsonb(t.*) into v_ver, v_snap;
    v_changed := p_fix ? 'back';
  elsif p_type = 'question' then
    update public.questions t
       set stem = coalesce(p_fix->>'stem', t.stem),
           explanation = coalesce(p_fix->>'explanation', t.explanation),
           payload = coalesce(p_fix->'payload', t.payload),
           version = t.version + 1
     where t.id = p_id
    returning t.version, to_jsonb(t.*) into v_ver, v_snap;
    v_changed := p_fix ? 'payload';
  elsif p_type = 'knowledge_node' then
    update public.knowledge_nodes t
       set title = coalesce(p_fix->>'title', t.title),
           summary = coalesce(p_fix->>'summary', t.summary),
           version = t.version + 1
     where t.id = p_id
    returning t.version, to_jsonb(t.*) into v_ver, v_snap;
  elsif p_type = 'glossary_term' then
    update public.glossary_terms t
       set definition = coalesce(p_fix->>'definition', t.definition),
           example = coalesce(p_fix->>'example', t.example),
           version = t.version + 1
     where t.id = p_id
    returning t.version, to_jsonb(t.*) into v_ver, v_snap;
  else
    raise exception 'fix not supported for this item type' using errcode = 'P0001', hint = 'invalid_request';
  end if;

  if v_ver is null then
    raise exception 'item not found' using errcode = 'P0001', hint = 'not_found';
  end if;

  insert into public.item_revisions (item_type, item_id, version, content, changed_by, flag_id, answer_changed)
  values (p_type, p_id, v_ver, v_snap, p_uid, p_flag, v_changed);
  return v_changed;
end $$;

-- ---------------------------------------------------------------------
-- TRU-02 resolve_flag: accept | reject | remove (api.md §5).
-- Moderators of the flag's Turma (for items of that Turma) or app admins.
-- Accepting applies the optional fix; the re-scoring of attempts is queued by the worker (flag.apply_fix).
-- ---------------------------------------------------------------------
create or replace function public.resolve_flag(p_flag_id uuid, p_decision text, p_fix jsonb default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_f       public.content_flags%rowtype;
  v_status  text;
  v_changed boolean := false;
  v_hideable boolean;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  select * into v_f from public.content_flags where id = p_flag_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if not (private.is_app_admin()
          or (v_f.class_group_id is not null and private.is_moderator(v_f.class_group_id)
              and private.item_belongs_to_group(v_f.item_type, v_f.item_id, v_f.class_group_id))) then
    raise exception 'not allowed' using errcode = 'P0001', hint = 'forbidden';
  end if;
  if v_f.status not in ('open','triaged','hidden_pending') then
    raise exception 'flag already resolved' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if p_decision not in ('accept','reject','remove') then
    raise exception 'unknown decision' using errcode = 'P0001', hint = 'invalid_request';
  end if;

  v_hideable := v_f.item_type in ('knowledge_node','card','question','glossary_term');

  if p_decision = 'remove' then
    perform private.hide_item(v_f.item_type, v_f.item_id, 'removed');
    insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id, flag_id)
    values (v_uid, case when private.is_app_admin() then 'app_admin' else 'moderator' end,
            'remove', v_f.item_type, v_f.item_id, v_f.id);
    v_status := 'removed';
  else
    if p_decision = 'accept' then
      v_status := 'accepted';
      if p_fix is not null then
        v_changed := private.apply_item_fix(v_f.item_type, v_f.item_id, p_fix, v_f.id, v_uid);
      end if;
    else
      v_status := 'rejected';
    end if;
    -- Closing a flag lifts the review hold it may have set (never a removal).
    if v_hideable then
      perform private.hide_item(v_f.item_type, v_f.item_id, null, true);
    end if;
  end if;

  update public.content_flags
     set status = v_status, resolved_by = v_uid, resolved_at = now()
   where id = p_flag_id;
end $$;

-- Grading rule that applies to a subject: the subject's own rule, else the school default for the year.
create or replace function private.grading_rule_for(p_user uuid, p_subject uuid, p_school_year smallint)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select g.formula from public.grading_rules g
   where g.owner_profile_id = p_user and g.school_year = p_school_year and g.deleted_at is null
     and (g.subject_id = p_subject or g.subject_id is null)
   order by (g.subject_id is null)
   limit 1;
$$;

-- Restores note statuses after an outline edit is undone: notes regenerated since the edit are
-- superseded, and the notes the edit archived get their previous status back (LRN-01.14).
create or replace function private.undo_note_states(p_nodes uuid[], p_prev jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notes set status = 'superseded'
   where node_id = any(p_nodes) and status in ('pending','generating','ready')
     and not (id = any(array(select (x->>'id')::uuid from jsonb_array_elements(coalesce(p_prev, '[]'::jsonb)) x)));
  update public.notes n set status = p.status
    from jsonb_to_recordset(coalesce(p_prev, '[]'::jsonb)) as p(id uuid, status text)
   where n.id = p.id;
end $$;

-- ---------------------------------------------------------------------
-- ING-04 outline edits. Ops: create, rename, move, reorder, delete (soft, subtree), merge, split, restore.
-- Every op writes a node_events row with {before, after}; undo_outline_event reverses it (30 days).
-- ---------------------------------------------------------------------
create or replace function public.edit_outline(p_subject_id uuid, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_op      jsonb;
  v_kind    text;
  v_node    public.knowledge_nodes%rowtype;
  v_other   public.knowledge_nodes%rowtype;
  v_new     uuid;
  v_tmp     uuid;
  v_event   uuid;
  v_events  uuid[] := '{}';
  v_regen   uuid[] := '{}';
  v_before  jsonb;
  v_after   jsonb;
  v_subtree uuid[];
  v_keep    uuid;
  v_drop    uuid;
  v_page    int;
  v_title   text;
  v_src     record;
  v_sources uuid[] := '{}';
  v_children uuid[] := '{}';
  v_cards   uuid[] := '{}';
  v_questions uuid[] := '{}';
  v_moved_src uuid[] := '{}';
  v_shortened jsonb := '[]'::jsonb;
  v_notes   jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.can_edit_subject(p_subject_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'invalid_ops'; end if;

  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_kind := v_op->>'op';

    if v_kind = 'create' then
      insert into public.knowledge_nodes (subject_id, parent_id, kind, title, position, edited_by_user)
      values (p_subject_id, nullif(v_op->>'parent_id', '')::uuid, v_op->>'kind', v_op->>'title',
              coalesce((v_op->>'position')::int, 0), true)
      returning id into v_new;
      insert into public.node_events (subject_id, node_id, actor_id, action, payload)
      values (p_subject_id, v_new, v_uid, 'create', jsonb_build_object('after', jsonb_build_object('id', v_new)))
      returning id into v_event;
      v_events := v_events || v_event;

    elsif v_kind in ('rename','move','reorder','delete') then
      select * into v_node from public.knowledge_nodes
       where id = (v_op->>'node_id')::uuid and subject_id = p_subject_id and deleted_at is null
       for update;
      if not found then raise exception 'node_not_found' using errcode = 'P0001', hint = 'not_found'; end if;

      if v_kind = 'rename' then
        v_before := jsonb_build_object('title', v_node.title);
        update public.knowledge_nodes set title = v_op->>'title', edited_by_user = true where id = v_node.id;
        v_after := jsonb_build_object('title', v_op->>'title');

      elsif v_kind = 'move' then
        v_before := jsonb_build_object('parent_id', v_node.parent_id, 'position', v_node.position);
        update public.knowledge_nodes
           set parent_id = nullif(v_op->>'parent_id', '')::uuid,
               position = coalesce((v_op->>'position')::int, v_node.position),
               edited_by_user = true
         where id = v_node.id;
        select jsonb_build_object('parent_id', n.parent_id, 'position', n.position) into v_after
          from public.knowledge_nodes n where n.id = v_node.id;

      elsif v_kind = 'reorder' then
        v_before := jsonb_build_object('position', v_node.position);
        update public.knowledge_nodes set position = (v_op->>'position')::int, edited_by_user = true
         where id = v_node.id;
        v_after := jsonb_build_object('position', (v_op->>'position')::int);

      else  -- delete: soft-delete the node and its live descendants
        with recursive sub as (
          select k.id from public.knowledge_nodes k where k.id = v_node.id
          union all
          select c.id from public.knowledge_nodes c join sub on c.parent_id = sub.id where c.deleted_at is null
        )
        select coalesce(array_agg(id), '{}') into v_subtree from sub;
        update public.knowledge_nodes set deleted_at = now() where id = any (v_subtree);
        v_before := jsonb_build_object('deleted_ids', to_jsonb(v_subtree));
        v_after := jsonb_build_object('deleted_ids', to_jsonb(v_subtree));
      end if;

      insert into public.node_events (subject_id, node_id, actor_id, action, payload)
      values (p_subject_id, v_node.id, v_uid,
              case v_kind when 'rename' then 'rename' when 'move' then 'move'
                          when 'reorder' then 'reorder' else 'delete' end,
              jsonb_build_object('before', v_before, 'after', v_after))
      returning id into v_event;
      v_events := v_events || v_event;

    elsif v_kind = 'merge' then
      -- ING-04.3: [keep, drop] topics. The keeper keeps its id and absorbs sources, children and items.
      if jsonb_typeof(v_op->'node_ids') <> 'array' or jsonb_array_length(v_op->'node_ids') <> 2 then
        raise exception 'merge needs two node ids' using errcode = 'P0001', hint = 'invalid_request';
      end if;
      v_keep := (v_op->'node_ids'->>0)::uuid;
      v_drop := (v_op->'node_ids'->>1)::uuid;
      if v_keep = v_drop then raise exception 'cannot merge a topic into itself' using errcode = 'P0001', hint = 'invalid_request'; end if;

      select * into v_node from public.knowledge_nodes
       where id = v_keep and subject_id = p_subject_id and kind = 'topic' and deleted_at is null for update;
      if not found then raise exception 'node_not_found' using errcode = 'P0001', hint = 'not_found'; end if;
      select * into v_other from public.knowledge_nodes
       where id = v_drop and subject_id = p_subject_id and kind = 'topic' and deleted_at is null for update;
      if not found then raise exception 'node_not_found' using errcode = 'P0001', hint = 'not_found'; end if;

      with u as (
        update public.node_sources s set node_id = v_keep
         where s.node_id = v_drop and s.deleted_at is null
           and not exists (select 1 from public.node_sources k
                            where k.node_id = v_keep and k.document_id = s.document_id
                              and k.page_start = s.page_start and k.page_end = s.page_end)
        returning s.id)
      select coalesce(array_agg(id), '{}') into v_sources from u;

      with u as (
        update public.knowledge_nodes c set parent_id = v_keep, edited_by_user = true
         where c.parent_id = v_drop and c.deleted_at is null
        returning c.id)
      select coalesce(array_agg(id), '{}') into v_children from u;

      with u as (update public.cards set node_id = v_keep where node_id = v_drop and deleted_at is null returning id)
      select coalesce(array_agg(id), '{}') into v_cards from u;

      with u as (update public.questions set node_id = v_keep where node_id = v_drop and deleted_at is null returning id)
      select coalesce(array_agg(id), '{}') into v_questions from u;

      select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'status', n.status)), '[]'::jsonb) into v_notes
        from public.notes n where n.node_id in (v_keep, v_drop) and n.status in ('pending','generating','ready');
      update public.notes set status = 'superseded'
       where node_id in (v_keep, v_drop) and status in ('pending','generating','ready');

      update public.knowledge_nodes set deleted_at = now(), edited_by_user = true where id = v_drop;
      update public.knowledge_nodes set edited_by_user = true where id = v_keep;

      v_before := jsonb_build_object('keep_id', v_keep, 'drop_id', v_drop, 'source_ids', to_jsonb(v_sources),
                                     'child_ids', to_jsonb(v_children), 'card_ids', to_jsonb(v_cards),
                                     'question_ids', to_jsonb(v_questions), 'notes', v_notes);
      v_after := jsonb_build_object('keep_id', v_keep, 'drop_id', v_drop);
      v_regen := array[v_keep];

      insert into public.node_events (subject_id, node_id, actor_id, action, payload)
      values (p_subject_id, v_keep, v_uid, 'merge', jsonb_build_object('before', v_before, 'after', v_after))
      returning id into v_event;
      v_events := v_events || v_event;

    elsif v_kind = 'split' then
      -- ING-04.4: the topic is cut before page p. Sources, concepts and items whose first page is >= p move
      -- to the new topic; a source that straddles p is shortened and copied for the new topic.
      if (v_op->>'page') is null then raise exception 'split needs a page' using errcode = 'P0001', hint = 'invalid_request'; end if;
      v_page := (v_op->>'page')::int;
      select * into v_node from public.knowledge_nodes
       where id = (v_op->>'node_id')::uuid and subject_id = p_subject_id and kind = 'topic' and deleted_at is null
       for update;
      if not found then raise exception 'node_not_found' using errcode = 'P0001', hint = 'not_found'; end if;

      v_new := public.uuid_v7();
      v_title := coalesce(nullif(v_op->>'title', ''), left(v_node.title, 180) || ' (parte 2)');
      insert into public.knowledge_nodes (id, subject_id, parent_id, kind, title, position, edited_by_user)
      values (v_new, p_subject_id, v_node.parent_id, 'topic', v_title, v_node.position + 1, true);

      for v_src in select * from public.node_sources
                    where node_id = v_node.id and deleted_at is null and page_end >= v_page
                    order by page_start
                    for update loop
        if v_src.page_start >= v_page then
          update public.node_sources set node_id = v_new where id = v_src.id;
          v_moved_src := v_moved_src || v_src.id;
        else
          update public.node_sources set page_end = v_page - 1 where id = v_src.id;
          insert into public.node_sources (node_id, document_id, page_start, page_end, origin)
          values (v_new, v_src.document_id, v_page, v_src.page_end, v_src.origin)
          returning id into v_tmp;
          v_shortened := v_shortened || jsonb_build_object('id', v_src.id, 'old_page_end', v_src.page_end, 'new_id', v_tmp);
        end if;
      end loop;

      with u as (
        update public.knowledge_nodes c set parent_id = v_new, edited_by_user = true
         where c.parent_id = v_node.id and c.deleted_at is null
           and (select min(s.page_start) from public.node_sources s
                 where s.node_id = c.id and s.deleted_at is null) >= v_page
        returning c.id)
      select coalesce(array_agg(id), '{}') into v_children from u;

      with u as (
        update public.cards c set node_id = v_new
         where c.node_id = v_node.id and c.deleted_at is null
           and (select min((x->>'page_start')::int) from jsonb_array_elements(c.source_pages) x) >= v_page
        returning c.id)
      select coalesce(array_agg(id), '{}') into v_cards from u;

      with u as (
        update public.questions q set node_id = v_new
         where q.node_id = v_node.id and q.deleted_at is null
           and (select min((x->>'page_start')::int) from jsonb_array_elements(q.source_pages) x) >= v_page
        returning q.id)
      select coalesce(array_agg(id), '{}') into v_questions from u;

      select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'status', n.status)), '[]'::jsonb) into v_notes
        from public.notes n where n.node_id in (v_node.id, v_new) and n.status in ('pending','generating','ready');
      update public.notes set status = 'superseded'
       where node_id in (v_node.id, v_new) and status in ('pending','generating','ready');

      update public.knowledge_nodes set edited_by_user = true where id = v_node.id;

      v_before := jsonb_build_object('node_id', v_node.id, 'new_node_id', v_new, 'moved_source_ids', to_jsonb(v_moved_src),
                                     'shortened', v_shortened, 'child_ids', to_jsonb(v_children),
                                     'card_ids', to_jsonb(v_cards), 'question_ids', to_jsonb(v_questions),
                                     'notes', v_notes);
      v_after := jsonb_build_object('node_id', v_node.id, 'new_node_id', v_new);
      v_regen := array[v_node.id, v_new];

      insert into public.node_events (subject_id, node_id, actor_id, action, payload)
      values (p_subject_id, v_node.id, v_uid, 'split', jsonb_build_object('before', v_before, 'after', v_after))
      returning id into v_event;
      v_events := v_events || v_event;

    elsif v_kind = 'restore' then
      -- ING-04.5: restores a soft-deleted node with the descendants deleted by the same operation (30 days).
      select * into v_node from public.knowledge_nodes
       where id = (v_op->>'node_id')::uuid and subject_id = p_subject_id and deleted_at is not null
       for update;
      if not found then raise exception 'node_not_found' using errcode = 'P0001', hint = 'not_found'; end if;
      if v_node.deleted_at < now() - interval '30 days' then
        raise exception 'restore window has passed' using errcode = 'P0001', hint = 'invalid_state';
      end if;
      if v_node.parent_id is not null and exists (
           select 1 from public.knowledge_nodes p where p.id = v_node.parent_id and p.deleted_at is not null) then
        raise exception 'restore the parent first' using errcode = 'P0001', hint = 'invalid_state';
      end if;

      with recursive sub as (
        select k.id from public.knowledge_nodes k where k.id = v_node.id
        union all
        select c.id from public.knowledge_nodes c join sub on c.parent_id = sub.id
         where c.deleted_at = v_node.deleted_at
      )
      select coalesce(array_agg(id), '{}') into v_subtree from sub;

      update public.knowledge_nodes set deleted_at = null where id = any (v_subtree);
      v_before := jsonb_build_object('deleted_at', v_node.deleted_at);
      v_after := jsonb_build_object('ids', to_jsonb(v_subtree));

      insert into public.node_events (subject_id, node_id, actor_id, action, payload)
      values (p_subject_id, v_node.id, v_uid, 'restore', jsonb_build_object('before', v_before, 'after', v_after))
      returning id into v_event;
      v_events := v_events || v_event;

    else
      raise exception 'unsupported_op' using detail = coalesce(v_kind, 'null');
    end if;
  end loop;

  return jsonb_build_object('event_ids', to_jsonb(v_events), 'regenerate_node_ids', to_jsonb(v_regen));
end $$;

-- ING-04.5: undo within 30 days. Reverses one node_events row.
create or replace function public.undo_outline_event(p_event_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ev  public.node_events%rowtype;
  v_b   jsonb;
  v_a   jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_ev from public.node_events where id = p_event_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if not private.can_edit_subject(v_ev.subject_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_ev.undone_at is not null then raise exception 'already_undone' using errcode = 'P0001', hint = 'invalid_state'; end if;
  if v_ev.created_at < now() - interval '30 days' then raise exception 'undo_expired' using errcode = 'P0001', hint = 'invalid_state'; end if;

  v_b := v_ev.payload->'before';
  v_a := v_ev.payload->'after';

  case v_ev.action
    when 'create' then
      update public.knowledge_nodes set deleted_at = now() where id = v_ev.node_id;
    when 'rename' then
      update public.knowledge_nodes set title = v_b->>'title' where id = v_ev.node_id;
    when 'move' then
      update public.knowledge_nodes
         set parent_id = nullif(v_b->>'parent_id', '')::uuid,
             position = (v_b->>'position')::int
       where id = v_ev.node_id;
    when 'reorder' then
      update public.knowledge_nodes set position = (v_b->>'position')::int where id = v_ev.node_id;
    when 'delete' then
      update public.knowledge_nodes set deleted_at = null
       where id = any(array(select jsonb_array_elements_text(v_b->'deleted_ids'))::uuid[]);
    when 'restore' then
      update public.knowledge_nodes set deleted_at = (v_b->>'deleted_at')::timestamptz
       where id = any(array(select jsonb_array_elements_text(v_a->'ids'))::uuid[]);
    when 'merge' then
      update public.knowledge_nodes set deleted_at = null where id = (v_b->>'drop_id')::uuid;
      update public.node_sources set node_id = (v_b->>'drop_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'source_ids'))::uuid[]);
      update public.knowledge_nodes set parent_id = (v_b->>'drop_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'child_ids'))::uuid[]);
      update public.cards set node_id = (v_b->>'drop_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'card_ids'))::uuid[]);
      update public.questions set node_id = (v_b->>'drop_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'question_ids'))::uuid[]);
      perform private.undo_note_states(array[(v_b->>'keep_id')::uuid, (v_b->>'drop_id')::uuid], v_b->'notes');
    when 'split' then
      update public.node_sources set node_id = (v_b->>'node_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'moved_source_ids'))::uuid[]);
      update public.node_sources s set page_end = (x->>'old_page_end')::int
        from jsonb_array_elements(v_b->'shortened') x
       where s.id = (x->>'id')::uuid;
      update public.node_sources set deleted_at = now()
       where node_id = (v_a->>'new_node_id')::uuid and deleted_at is null;
      update public.knowledge_nodes set deleted_at = now() where id = (v_a->>'new_node_id')::uuid;
      update public.knowledge_nodes set parent_id = (v_b->>'node_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'child_ids'))::uuid[]);
      update public.cards set node_id = (v_b->>'node_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'card_ids'))::uuid[]);
      update public.questions set node_id = (v_b->>'node_id')::uuid
       where id = any(array(select jsonb_array_elements_text(v_b->'question_ids'))::uuid[]);
      perform private.undo_note_states(array[(v_b->>'node_id')::uuid, (v_a->>'new_node_id')::uuid], v_b->'notes');
    else
      raise exception 'not_undoable' using errcode = 'P0001', hint = 'invalid_state';
  end case;

  update public.node_events set undone_at = now() where id = p_event_id;
end $$;

-- ---------------------------------------------------------------------
-- SP-09 handle_report. remove_content hides the reported item (hidden_reason = removed) and logs it.
-- It needs an item in context_type / context_id that belongs to the report's Turma (or an app admin).
-- ---------------------------------------------------------------------
create or replace function public.handle_report(p_report_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_r   public.user_reports%rowtype;
  v_status text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_r from public.user_reports where id = p_report_id for update;
  if not found then raise exception 'not_found'; end if;
  if not (private.is_app_admin()
          or (v_r.class_group_id is not null and private.is_moderator(v_r.class_group_id))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  case p_action
    when 'dismiss' then v_status := 'dismissed';
    when 'warn' then v_status := 'actioned';
    when 'escalate' then v_status := 'escalated';
    when 'remove_member' then
      if v_r.reported_id is null or v_r.class_group_id is null then raise exception 'invalid_state'; end if;
      if exists (select 1 from public.class_group_members
                 where class_group_id = v_r.class_group_id and user_id = v_r.reported_id and role = 'owner') then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      update public.class_group_members set status = 'removed', left_at = now()
       where class_group_id = v_r.class_group_id and user_id = v_r.reported_id;
      insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id, report_id)
      values (v_uid, case when private.is_app_admin() then 'app_admin' else 'moderator' end,
              'remove_member', 'user', v_r.reported_id, v_r.id);
      v_status := 'actioned';
    when 'remove_content' then
      if v_r.context_type is null or v_r.context_id is null then
        raise exception 'the report has no content to remove' using errcode = 'P0001', hint = 'invalid_state';
      end if;
      if not (private.is_app_admin()
              or (v_r.class_group_id is not null
                  and private.item_belongs_to_group(v_r.context_type, v_r.context_id, v_r.class_group_id))) then
        raise exception 'content is outside the Turma' using errcode = 'P0001', hint = 'forbidden';
      end if;
      perform private.hide_item(v_r.context_type, v_r.context_id, 'removed');
      insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id, report_id)
      values (v_uid, case when private.is_app_admin() then 'app_admin' else 'moderator' end,
              'remove', v_r.context_type, v_r.context_id, v_r.id);
      v_status := 'actioned';
    else raise exception 'invalid_action';
  end case;

  update public.user_reports set status = v_status, handled_by = v_uid, handled_at = now() where id = p_report_id;
end $$;

-- ---------------------------------------------------------------------
-- GOL-03 confirm_exam_scope. Replaces the confirmed scope of an exam with the given topics (or the
-- subject's topics when default_all). Nodes outside the exam's subject and nodes the student marked
-- "não cai na prova" (ING-04.6) are left out. Sets exams.scope_status = confirmed.
-- The replan (plan.recompute) is queued by the worker, not here.
-- ---------------------------------------------------------------------
create or replace function public.confirm_exam_scope(p_exam_id uuid, p_node_ids uuid[], p_default_all boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_exam public.exams%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  select * into v_exam from public.exams
   where id = p_exam_id and user_id = v_uid and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_exam.status = 'cancelled' then raise exception 'exam is cancelled' using errcode = 'P0001', hint = 'invalid_state'; end if;
  if v_exam.subject_id is null then raise exception 'the exam has no subject' using errcode = 'P0001', hint = 'invalid_state'; end if;

  -- Tombstone the previous confirmed/suggested scope, then upsert the new one.
  update public.exam_scope_nodes set deleted_at = now()
   where exam_id = p_exam_id and deleted_at is null;

  insert into public.exam_scope_nodes (exam_id, node_id, source, confirmed, deleted_at)
  select p_exam_id, n.id, 'user', true, null
    from public.knowledge_nodes n
   where n.id = any(coalesce(p_node_ids, '{}'))
     and n.subject_id = v_exam.subject_id and n.deleted_at is null
     and not exists (select 1 from public.node_user_settings us
                      where us.user_id = v_uid and us.node_id = n.id and us.excluded and us.deleted_at is null)
  on conflict (exam_id, node_id) do update
    set source = excluded.source, confirmed = true, deleted_at = null, updated_at = now();

  if p_default_all then
    insert into public.exam_scope_nodes (exam_id, node_id, source, confirmed, deleted_at)
    select p_exam_id, n.id, 'default_all', true, null
      from public.knowledge_nodes n
     where n.subject_id = v_exam.subject_id and n.kind = 'topic' and n.deleted_at is null
       and not exists (select 1 from public.node_user_settings us
                        where us.user_id = v_uid and us.node_id = n.id and us.excluded and us.deleted_at is null)
    on conflict (exam_id, node_id) do update
      set source = excluded.source, confirmed = true, deleted_at = null, updated_at = now();
  end if;

  update public.exams set scope_status = 'confirmed' where id = p_exam_id;
end $$;

-- ---------------------------------------------------------------------
-- GOL-06 log_exam_grade. Stores the grade on the exam (status done) and on the grade component linked
-- to it, then returns the grade each still-pending component needs.
-- SQL solver: weighted_average terms with a passing average and ceiling to grade_step only. Points-sum,
-- recuperação, final exam and rounding policies are computed by the shared solver in packages/shared
-- (spec 07 §8.5); this function returns {required: []} for anything it does not cover.
-- ---------------------------------------------------------------------
create or replace function public.log_exam_grade(p_exam_id uuid, p_grade numeric, p_grade_max numeric)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_exam    public.exams%rowtype;
  v_comp    public.grade_components%rowtype;
  v_rule    jsonb;
  v_scale   numeric;
  v_step    numeric;
  v_target  numeric;
  v_total_w numeric;
  v_known   numeric;
  v_pending numeric;
  v_x       numeric;
  v_needed  numeric;
  v_status  text;
  v_required jsonb := '[]'::jsonb;
  r         record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_grade is null or p_grade_max is null or p_grade_max <= 0 or p_grade < 0 or p_grade > p_grade_max then
    raise exception 'invalid grade' using errcode = 'P0001', hint = 'invalid_request';
  end if;

  select * into v_exam from public.exams
   where id = p_exam_id and user_id = v_uid and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_exam.status not in ('scheduled','done') then
    raise exception 'exam cannot take a grade' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  update public.exams set grade = p_grade, grade_max = p_grade_max, status = 'done' where id = p_exam_id;

  select * into v_comp from public.grade_components
   where exam_id = p_exam_id and user_id = v_uid and deleted_at is null
   order by position limit 1;
  if not found then
    return jsonb_build_object('required', v_required);
  end if;

  v_rule := private.grading_rule_for(v_uid, v_comp.subject_id, v_comp.school_year);
  -- The component stores the grade on the rule's scale (without a rule, on the exam's own scale).
  v_scale := coalesce((v_rule->>'scale_max')::numeric, p_grade_max);
  update public.grade_components set grade = p_grade * v_scale / p_grade_max where id = v_comp.id;

  if v_rule is null or coalesce(v_rule->>'term_formula', 'weighted_average') <> 'weighted_average' then
    return jsonb_build_object('required', v_required);
  end if;

  v_step   := coalesce((v_rule->>'grade_step')::numeric, 0.1);
  v_target := coalesce((v_rule->>'passing_average')::numeric, 6);

  select coalesce(sum(weight), 0),
         coalesce(sum(weight * grade) filter (where grade is not null), 0),
         coalesce(sum(weight) filter (where grade is null), 0)
    into v_total_w, v_known, v_pending
    from public.grade_components
   where user_id = v_uid and subject_id = v_comp.subject_id and school_year = v_comp.school_year
     and term_index = v_comp.term_index and deleted_at is null and weight is not null;

  if v_pending = 0 then
    return jsonb_build_object('required', v_required);
  end if;

  -- The same grade x on every pending component (GOL-06.5): target * W = known + pending * x.
  v_x := (v_target * v_total_w - v_known) / v_pending;
  if v_x <= 0 then
    v_needed := 0;
    v_status := 'secured';
  else
    v_needed := ceil(v_x / v_step) * v_step;
    v_status := case when v_needed > v_scale then 'impossible' else 'needed' end;
  end if;

  for r in
    select c.exam_id from public.grade_components c
     where c.user_id = v_uid and c.subject_id = v_comp.subject_id and c.school_year = v_comp.school_year
       and c.term_index = v_comp.term_index and c.deleted_at is null and c.weight is not null
       and c.grade is null and c.exam_id is not null
  loop
    v_required := v_required || jsonb_build_object('exam_id', r.exam_id, 'needed', v_needed, 'status', v_status);
  end loop;

  return jsonb_build_object('required', v_required);
end $$;

-- ---------------------------------------------------------------------
-- GOL-12 Modo Desespero. One active mode per (user, goal). Eligibility (GOL-12.1/.2): every listed exam is a
-- scheduled test of the goal, owned by the caller, dated today..today+6 in the user's timezone.
-- The diagnostic quiz (GOL-12.3) is created by quiz-create (Edge); diagnostic_quiz_id is returned as null.
-- ---------------------------------------------------------------------
create or replace function public.start_desperate_mode(p_goal_id uuid, p_exam_ids uuid[], p_minutes_per_day int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_tz    text;
  v_today date;
  v_count int;
  v_last  date;
  v_id    uuid := public.uuid_v7();
  d       date;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_exam_ids is null or cardinality(p_exam_ids) = 0 then
    raise exception 'no exams' using errcode = 'P0001', hint = 'invalid_request';
  end if;
  if p_minutes_per_day is null or p_minutes_per_day not between 60 and 240 then
    raise exception 'minutes per day must be 60-240' using errcode = 'P0001', hint = 'invalid_request';
  end if;
  if not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid and g.deleted_at is null) then
    raise exception 'goal not found' using errcode = 'P0001', hint = 'not_found';
  end if;
  if exists (select 1 from public.desperate_modes m
              where m.user_id = v_uid and m.goal_id = p_goal_id and m.status = 'active' and m.deleted_at is null) then
    raise exception 'desperate mode already active' using errcode = 'P0001', hint = 'already_exists';
  end if;

  select coalesce(p.timezone, 'America/Sao_Paulo') into v_tz from public.profiles p where p.id = v_uid;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  v_today := (now() at time zone v_tz)::date;

  select count(*), max(e.local_date) into v_count, v_last
    from public.exams e
   where e.id = any(p_exam_ids) and e.goal_id = p_goal_id and e.user_id = v_uid and e.deleted_at is null
     and e.status = 'scheduled' and e.local_date between v_today and v_today + 6;
  if v_count <> (select count(distinct x) from unnest(p_exam_ids) x) then
    raise exception 'exam is outside the 7-day window' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  insert into public.desperate_modes (id, user_id, goal_id, status, exam_ids, minutes_per_day, started_at)
  values (v_id, v_uid, p_goal_id, 'active', p_exam_ids, p_minutes_per_day, now());

  -- GOL-12.4: the chosen time overrides the available minutes of each day until the last covered test.
  -- A day the student set by hand keeps their value.
  for d in select generate_series(v_today, v_last, interval '1 day')::date loop
    insert into public.availability_exceptions (user_id, local_date, minutes, source)
    values (v_uid, d, p_minutes_per_day, 'desperate')
    on conflict (user_id, local_date) do update
      set minutes = excluded.minutes, source = 'desperate', deleted_at = null, updated_at = now()
      where public.availability_exceptions.deleted_at is not null
         or public.availability_exceptions.source = 'desperate';
  end loop;

  return jsonb_build_object('desperate_mode_id', v_id, 'diagnostic_quiz_id', null);
end $$;

-- GOL-12.5: moves topics between Foco total (focus), Só o básico (basic) and Fica de fora (out).
-- Coverage is the share of confirmed scope topics of each exam that sit in focus or basic.
create or replace function public.set_desperate_groups(p_desperate_mode_id uuid, p_moves jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_m      public.desperate_modes%rowtype;
  v_mv     jsonb;
  v_node   uuid;
  v_group  text;
  v_groups jsonb;
  v_cov    jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_m from public.desperate_modes
   where id = p_desperate_mode_id and user_id = v_uid and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_m.status <> 'active' then raise exception 'desperate mode is not active' using errcode = 'P0001', hint = 'invalid_state'; end if;
  if jsonb_typeof(p_moves) <> 'array' then raise exception 'moves must be an array' using errcode = 'P0001', hint = 'invalid_request'; end if;

  for v_mv in select value from jsonb_array_elements(p_moves) loop
    v_node := (v_mv->>'node_id')::uuid;
    v_group := v_mv->>'group';
    if v_node is null or coalesce(v_group, '') not in ('focus','basic','out') then
      raise exception 'invalid move' using errcode = 'P0001', hint = 'invalid_request';
    end if;
    if not exists (select 1 from public.knowledge_nodes n
                     join public.exams e on e.subject_id = n.subject_id
                    where n.id = v_node and e.id = any(v_m.exam_ids) and n.deleted_at is null) then
      raise exception 'node not found' using errcode = 'P0001', hint = 'not_found';
    end if;
    update public.desperate_modes
       set topic_groups = topic_groups || jsonb_build_object(v_node::text, v_group),
           user_moves = user_moves || jsonb_build_array(jsonb_build_object('node_id', v_node, 'group', v_group))
     where id = v_m.id;
  end loop;

  select topic_groups into v_groups from public.desperate_modes where id = v_m.id;

  select coalesce(jsonb_agg(jsonb_build_object('exam_id', c.exam_id,
                                               'pct', case when c.total = 0 then 0
                                                           else round(100.0 * c.covered / c.total)::int end)
                            order by c.exam_id), '[]'::jsonb)
    into v_cov
    from (select e.id as exam_id,
                 count(s.node_id) as total,
                 count(s.node_id) filter (where v_groups->>(s.node_id::text) in ('focus','basic')) as covered
            from public.exams e
            left join public.exam_scope_nodes s
              on s.exam_id = e.id and s.confirmed and s.deleted_at is null
           where e.id = any(v_m.exam_ids)
           group by e.id) c;

  return jsonb_build_object('topic_groups', v_groups, 'coverage', v_cov);
end $$;

-- GOL-12.11: ends the mode and removes its future desperate availability rows (history is kept).
create or replace function public.end_desperate_mode(p_desperate_mode_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_m     public.desperate_modes%rowtype;
  v_tz    text;
  v_today date;
  v_last  date;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_m from public.desperate_modes
   where id = p_desperate_mode_id and user_id = v_uid and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_m.status <> 'active' then raise exception 'desperate mode is not active' using errcode = 'P0001', hint = 'invalid_state'; end if;

  select coalesce(p.timezone, 'America/Sao_Paulo') into v_tz from public.profiles p where p.id = v_uid;
  v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
  select max(e.local_date) into v_last from public.exams e where e.id = any(v_m.exam_ids);

  update public.desperate_modes set status = 'ended', ended_at = now() where id = v_m.id;
  update public.availability_exceptions set deleted_at = now(), updated_at = now()
   where user_id = v_uid and source = 'desperate' and deleted_at is null
     and local_date >= v_today and local_date <= coalesce(v_last, v_today);

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Grants. Signed-in users may call the RPCs; the record_join_failure RPC is for the service role only.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname in (
              'join_class_group','edit_outline','undo_outline_event','handle_report','confirm_exam_scope',
              'log_exam_grade','start_desperate_mode','set_desperate_groups','end_desperate_mode','resolve_flag'))
        or (n.nspname = 'private' and p.proname in (
              'undo_note_states','item_belongs_to_group','hide_item','apply_item_fix','grading_rule_for'))
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

-- Internal helpers: the RPCs above run as the function owner, so the signed-in role needs no access.
revoke all on function private.undo_note_states(uuid[], jsonb) from public, anon, authenticated;
revoke all on function private.item_belongs_to_group(text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.hide_item(text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function private.apply_item_fix(text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function private.grading_rule_for(uuid, uuid, smallint) from public, anon, authenticated;

revoke all on function public.record_join_failure(uuid) from public, anon, authenticated;
grant execute on function public.record_join_failure(uuid) to service_role;
