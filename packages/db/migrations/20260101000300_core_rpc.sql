-- RPCs for the foundation tables (docs/engineering/api.md §5) and the PLT-04 budget gate
-- (ai-pipeline.md §9.1, security-privacy.md §7). Skipped: RPCs whose tables are created later
-- (confirm_exam_scope, log_exam_grade, resolve_flag, class_insights_for, desperate mode, SISU,
-- schedule import, sync_snapshot). All security definer, search_path = '', explicit auth checks.

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Invite codes: 8 chars from the unambiguous alphabet in security-privacy.md §9 (31 symbols).
-- Rejection sampling keeps the distribution uniform (248 = 8 * 31).
create or replace function private.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_out text := '';
  v_byte int;
begin
  while char_length(v_out) < 8 loop
    v_byte := get_byte(public.gen_random_bytes(1), 0);
    if v_byte < 248 then
      v_out := v_out || substr(v_alphabet, 1 + (v_byte % 31), 1);
    end if;
  end loop;
  return v_out;
end $$;

-- Creates an invite with a fresh code (retries on the rare code collision).
create or replace function private.issue_invite(p_created_by uuid, p_group uuid, p_expires_days int, p_uses_left int)
returns table (invite_code text, invite_expires_at timestamptz)
language plpgsql set search_path = '' as $$
declare
  v_code text;
  v_exp  timestamptz := now() + make_interval(days => p_expires_days);
  v_try  int := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := private.new_invite_code();
    begin
      insert into public.invites (code, created_by, class_group_id, uses_left, expires_at)
      values (v_code, p_created_by, p_group, p_uses_left, v_exp);
      invite_code := v_code;
      invite_expires_at := v_exp;
      return next;
      return;
    exception when unique_violation then
      if v_try >= 5 then raise; end if;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Platform
-- ---------------------------------------------------------------------

-- api.md §5 my_feature_flags(): keys that are on for the caller (all, user, Turma or percentage rollout).
create or replace function public.my_feature_flags() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f.key order by f.key), '{}'::text[])
  from public.feature_flags f
  where f.enabled_all
     or auth.uid() = any (f.user_ids)
     or exists (select 1 from public.class_group_members m
                where m.user_id = auth.uid() and m.status = 'active'
                  and m.class_group_id = any (f.class_group_ids))
     or (auth.uid() is not null
         and (hashtext(f.key || ':' || auth.uid()::text) & 2147483647) % 100 < f.percentage);
$$;

-- ---------------------------------------------------------------------
-- Turma: creation, invites, membership, moderation (api.md §5, SOC-01)
-- ---------------------------------------------------------------------

create or replace function public.create_class_group(p_name text, p_school text default null, p_school_year text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_group uuid := public.uuid_v7();
  v_code  text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  insert into public.class_groups (id, name, owner_id, school, school_year)
  values (v_group, p_name, v_uid, p_school, p_school_year);
  insert into public.class_group_members (class_group_id, user_id, role, status, joined_at)
  values (v_group, v_uid, 'owner', 'active', now());

  select i.invite_code into v_code from private.issue_invite(v_uid, v_group, 7, null) i;
  return jsonb_build_object('class_group_id', v_group, 'invite_code', v_code);
end $$;

-- Redeem a Turma code. Errors: invite_invalid, invite_expired, invite_used_up, banned, class_full.
-- Rate limiting (5 failed codes per hour, SOC-01.14) needs an attempts table; not in this migration.
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

-- api.md §5 rotate_invite: the newest non-revoked invite is the Turma's current link.
create or replace function public.rotate_invite(p_class_group_id uuid, p_expires_in_days int default 7, p_uses_left int default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
  v_exp  timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.is_moderator(p_class_group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_expires_in_days is null or p_expires_in_days not between 1 and 30 then raise exception 'invalid_expiry'; end if;

  update public.invites set revoked_at = now()
   where class_group_id = p_class_group_id and revoked_at is null;

  select i.invite_code, i.invite_expires_at into v_code, v_exp
    from private.issue_invite(v_uid, p_class_group_id, p_expires_in_days, p_uses_left) i;
  return jsonb_build_object('invite_code', v_code, 'expires_at', v_exp);
end $$;

-- api.md §5 moderate_member. Owners can act on anyone; moderators on members and pending users.
-- Logs remove/ban/unban to private.moderation_actions (security §12).
create or replace function public.moderate_member(p_class_group_id uuid, p_user_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_actor text;
  v_m     public.class_group_members%rowtype;
  v_active int;
  v_cap   int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_action not in ('approve','reject','remove','ban','unban','promote','demote') then
    raise exception 'invalid_action';
  end if;
  if not private.is_moderator(p_class_group_id) then raise exception 'forbidden' using errcode = '42501'; end if;

  select role into v_actor from public.class_group_members
   where class_group_id = p_class_group_id and user_id = v_uid and status = 'active';

  select * into v_m from public.class_group_members
   where class_group_id = p_class_group_id and user_id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if v_m.role = 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_m.role = 'moderator' and v_actor <> 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_action in ('promote','demote') and v_actor <> 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;

  case p_action
    when 'approve' then
      if v_m.status <> 'pending' then raise exception 'invalid_state'; end if;
      select member_cap into v_cap from public.class_groups where id = p_class_group_id;
      select count(*) into v_active from public.class_group_members
       where class_group_id = p_class_group_id and status = 'active';
      if v_active >= v_cap then raise exception 'class_full'; end if;
      update public.class_group_members
         set status = 'active', joined_at = now(), approved_by = v_uid
       where class_group_id = p_class_group_id and user_id = p_user_id;
    when 'reject' then
      if v_m.status <> 'pending' then raise exception 'invalid_state'; end if;
      update public.class_group_members set status = 'removed'
       where class_group_id = p_class_group_id and user_id = p_user_id;
    when 'remove' then
      if v_m.status not in ('active','pending') then raise exception 'invalid_state'; end if;
      update public.class_group_members set status = 'removed', left_at = now()
       where class_group_id = p_class_group_id and user_id = p_user_id;
      insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id)
      values (v_uid, case when v_actor = 'owner' then 'owner' else 'moderator' end, 'remove_member', 'user', p_user_id);
    when 'ban' then
      update public.class_group_members set status = 'banned', left_at = now()
       where class_group_id = p_class_group_id and user_id = p_user_id;
      insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id)
      values (v_uid, case when v_actor = 'owner' then 'owner' else 'moderator' end, 'ban', 'user', p_user_id);
    when 'unban' then
      if v_m.status <> 'banned' then raise exception 'invalid_state'; end if;
      update public.class_group_members set status = 'removed'
       where class_group_id = p_class_group_id and user_id = p_user_id;
      insert into private.moderation_actions (actor_id, actor_kind, action, target_type, target_id)
      values (v_uid, case when v_actor = 'owner' then 'owner' else 'moderator' end, 'unban', 'user', p_user_id);
    when 'promote' then
      if v_m.status <> 'active' or v_m.role <> 'member' then raise exception 'invalid_state'; end if;
      update public.class_group_members set role = 'moderator'
       where class_group_id = p_class_group_id and user_id = p_user_id;
    when 'demote' then
      if v_m.role <> 'moderator' then raise exception 'invalid_state'; end if;
      update public.class_group_members set role = 'member'
       where class_group_id = p_class_group_id and user_id = p_user_id;
  end case;
end $$;

create or replace function public.leave_class_group(p_class_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.class_group_members%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_m from public.class_group_members
   where class_group_id = p_class_group_id and user_id = v_uid for update;
  if not found or v_m.status <> 'active' then raise exception 'not_member' using errcode = '42501'; end if;
  if v_m.role = 'owner' then raise exception 'owner_must_transfer'; end if;
  update public.class_group_members set status = 'left', left_at = now()
   where class_group_id = p_class_group_id and user_id = v_uid;
end $$;

-- ---------------------------------------------------------------------
-- Subjects and outline (api.md §5, ING-04, SOC-01.10)
-- ---------------------------------------------------------------------

create or replace function public.create_shared_subject(p_class_group_id uuid, p_name text, p_color text, p_icon text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.is_member(p_class_group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not (private.is_moderator(p_class_group_id)
          or exists (select 1 from public.class_groups g
                     where g.id = p_class_group_id and g.allow_member_uploads)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.subjects (owner_class_group_id, created_by, name, color, icon)
  values (p_class_group_id, v_uid, p_name, p_color, p_icon)
  returning id into v_id;
  return v_id;
end $$;

-- Moves the uploader's personal subject into a Turma. Per-user state is untouched; the sharer keeps
-- edit rights through created_by (SOC-01.10). Copyright attestation is recorded on their uploads.
create or replace function public.share_subject(p_subject_id uuid, p_class_group_id uuid, p_copyright_ack boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not p_copyright_ack then raise exception 'copyright_ack_required'; end if;
  if not exists (select 1 from public.subjects
                 where id = p_subject_id and owner_profile_id = v_uid and deleted_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not (private.is_moderator(p_class_group_id)
          or (private.is_member(p_class_group_id)
              and exists (select 1 from public.class_groups g
                          where g.id = p_class_group_id and g.allow_member_uploads))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.subjects
     set owner_profile_id = null, owner_class_group_id = p_class_group_id
   where id = p_subject_id;
  update public.documents set copyright_ack_at = now()
   where subject_id = p_subject_id and uploaded_by = v_uid and copyright_ack_at is null;
end $$;

-- ING-04 outline edits. Supported ops: create, rename, move, reorder, delete (soft, subtree).
-- merge, split and restore need the regeneration job and are rejected here (unsupported_op).
-- Every op writes a node_events row with {before, after} so undo_outline_event can reverse it.
create or replace function public.edit_outline(p_subject_id uuid, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_op      jsonb;
  v_kind    text;
  v_node    public.knowledge_nodes%rowtype;
  v_new     uuid;
  v_event   uuid;
  v_events  uuid[] := '{}';
  v_before  jsonb;
  v_after   jsonb;
  v_subtree uuid[];
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
      if not found then raise exception 'node_not_found'; end if;

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

    else
      raise exception 'unsupported_op' using detail = coalesce(v_kind, 'null');
    end if;
  end loop;

  return jsonb_build_object('event_ids', to_jsonb(v_events), 'regenerate_node_ids', '[]'::jsonb);
end $$;

-- ING-04.5: undo within 30 days. Reverses one node_events row.
create or replace function public.undo_outline_event(p_event_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ev  public.node_events%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_ev from public.node_events where id = p_event_id for update;
  if not found then raise exception 'not_found'; end if;
  if not private.can_edit_subject(v_ev.subject_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_ev.undone_at is not null then raise exception 'already_undone'; end if;
  if v_ev.created_at < now() - interval '30 days' then raise exception 'undo_expired'; end if;

  case v_ev.action
    when 'create' then
      update public.knowledge_nodes set deleted_at = now() where id = v_ev.node_id;
    when 'rename' then
      update public.knowledge_nodes set title = v_ev.payload->'before'->>'title' where id = v_ev.node_id;
    when 'move' then
      update public.knowledge_nodes
         set parent_id = nullif(v_ev.payload->'before'->>'parent_id', '')::uuid,
             position = (v_ev.payload->'before'->>'position')::int
       where id = v_ev.node_id;
    when 'reorder' then
      update public.knowledge_nodes set position = (v_ev.payload->'before'->>'position')::int
       where id = v_ev.node_id;
    when 'delete' then
      update public.knowledge_nodes set deleted_at = null
       where id = any (array(select jsonb_array_elements_text(v_ev.payload->'before'->'deleted_ids'))::uuid[]);
    else
      raise exception 'not_undoable';
  end case;

  update public.node_events set undone_at = now() where id = p_event_id;
end $$;

-- ---------------------------------------------------------------------
-- Reports and blocks (api.md §5, SP-09, security §9)
-- ---------------------------------------------------------------------

-- remove_content is listed in api.md but needs content_flags / item hides (a later migration).
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
    when 'remove_content' then raise exception 'unsupported_action';
    else raise exception 'invalid_action';
  end case;

  update public.user_reports set status = v_status, handled_by = v_uid, handled_at = now() where id = p_report_id;
end $$;

-- Blocking hides the pair from each other's duels, battles and leaderboards (the duel cancel is a later migration).
create or replace function public.block_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_user_id = v_uid then raise exception 'invalid_target'; end if;
  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, p_user_id)
  on conflict do nothing;
end $$;

create or replace function public.unblock_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.user_blocks where blocker_id = auth.uid() and blocked_id = p_user_id;
end $$;

-- ---------------------------------------------------------------------
-- Turma AI spend, moderators only (api.md §5, PLT-04.5)
-- ---------------------------------------------------------------------

create or replace function public.class_group_ai_usage(p_class_group_id uuid, p_month date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_limit bigint;
  v_spent bigint;
  v_by    jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.is_moderator(p_class_group_id) then raise exception 'forbidden' using errcode = '42501'; end if;

  select ai_budget_monthly_micro_usd into v_limit from public.class_groups where id = p_class_group_id;
  select coalesce(sum(u.cost_micro_usd), 0) into v_spent from public.ai_usage u
   where u.class_group_id = p_class_group_id
     and (u.created_at at time zone 'America/Sao_Paulo')::date >= v_start
     and (u.created_at at time zone 'America/Sao_Paulo')::date < v_end;
  select coalesce(jsonb_object_agg(x.feature, x.cost), '{}'::jsonb) into v_by from (
    select u.feature, sum(u.cost_micro_usd) as cost from public.ai_usage u
     where u.class_group_id = p_class_group_id
       and (u.created_at at time zone 'America/Sao_Paulo')::date >= v_start
       and (u.created_at at time zone 'America/Sao_Paulo')::date < v_end
     group by u.feature) x;

  return jsonb_build_object(
    'spent_pct', case when coalesce(v_limit, 0) > 0 then round(v_spent * 100.0 / v_limit, 1) end,
    'by_feature', v_by);
end $$;

-- ---------------------------------------------------------------------
-- PLT-04 budget gate (ai-pipeline.md §9.1). Service role only.
-- Scopes: user/day (local day), class_group/month (Turma), global/month. Budget rows are locked
-- with FOR UPDATE, so parallel requests cannot overspend. Limits are placeholders until the owner
-- sets them (security-privacy.md §7; Phase 0 measures real cost, ai-pipeline.md §9.4).
-- ---------------------------------------------------------------------

create or replace function private.ai_budget_limit(p_scope_type text, p_scope_id uuid, p_period_type text)
returns bigint
language plpgsql stable set search_path = '' as $$
declare
  v_limit bigint;
begin
  if p_scope_type = 'user' then
    return 1000000;                                   -- placeholder: $1.00 per user per day
  elsif p_scope_type = 'class_group' then
    select ai_budget_monthly_micro_usd into v_limit from public.class_groups where id = p_scope_id;
    return coalesce(v_limit, 50000000);               -- placeholder: $50 per Turma per month when unset
  elsif p_scope_type = 'global' then
    return 100000000;                                 -- placeholder: $100 global per month
  end if;
  raise exception 'unknown budget scope %', p_scope_type;
end $$;

-- Releases reservations whose call never settled (crashed request) after their 10-minute hold.
create or replace function private.ai_budget_release_expired() returns void
language plpgsql security definer set search_path = '' as $$
begin
  with released as (
    update private.ai_budget_reservations r set status = 'released'
     where r.status = 'reserved' and r.expires_at < now()
    returning r.scope_type, r.scope_id, r.period_type, r.period_start, r.amount_micro_usd
  ), totals as (
    select scope_type, scope_id, period_type, period_start, sum(amount_micro_usd) as amt
      from released group by 1, 2, 3, 4
  )
  update private.ai_budgets b
     set reserved_micro_usd = greatest(0, b.reserved_micro_usd - t.amt), updated_at = now()
    from totals t
   where b.scope_type = t.scope_type and b.scope_id = t.scope_id
     and b.period_type = t.period_type and b.period_start = t.period_start;
end $$;

-- Reserves an estimate across every scope that applies. Raises budget_exhausted (names the scope in
-- DETAIL and the reset date in HINT) without changing anything. Returns the reservation id.
-- p_budget_class: 'user' (acting user's day), 'content' (Turma month for shared subjects, else user day),
-- 'system' (global month only).
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

-- Records the actual cost on every scope of a reservation and releases the unused hold.
-- Idempotent: settled reservations are not changed again.
create or replace function private.ai_budget_settle(p_reservation_id uuid, p_actual_micro_usd bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if p_actual_micro_usd is null or p_actual_micro_usd < 0 then
    raise exception 'invalid actual cost' using errcode = '22023';
  end if;
  for r in
    select * from private.ai_budget_reservations
     where reservation_id = p_reservation_id and status in ('reserved','released')
     for update
  loop
    update private.ai_budgets
       set reserved_micro_usd = case when r.status = 'reserved'
                                     then greatest(0, reserved_micro_usd - r.amount_micro_usd)
                                     else reserved_micro_usd end,
           spent_micro_usd = spent_micro_usd + p_actual_micro_usd,
           updated_at = now()
     where scope_type = r.scope_type and scope_id = r.scope_id
       and period_type = r.period_type and period_start = r.period_start;
    update private.ai_budget_reservations set status = 'settled', settled_at = now()
     where reservation_id = r.reservation_id and scope_type = r.scope_type and scope_id = r.scope_id
       and period_type = r.period_type and period_start = r.period_start;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Grants for functions: RPCs are callable by signed-in users; helpers by policies; budget functions
-- by the service role only. Default EXECUTE to PUBLIC is removed from all of them.
-- ---------------------------------------------------------------------
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.proname <> 'uuid_v7'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;

  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname not like 'ai_budget%' and p.proname <> 'issue_invite'
       and p.proname <> 'new_invite_code'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;

  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and (p.proname like 'ai_budget%' or p.proname in ('issue_invite','new_invite_code'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

grant execute on function public.uuid_v7() to anon, authenticated, service_role;
