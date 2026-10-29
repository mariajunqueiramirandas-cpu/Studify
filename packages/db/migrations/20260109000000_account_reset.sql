-- Account reset (Perfil → Privacidade → Recomeçar do zero). Keeps the login and the profile identity (name,
-- birth date, school year, role, invite and privacy acceptance, so the student does not need a new invite) and
-- removes everything else the student owns. Unlike account deletion, the auth user and the profile row stay, so
-- nothing cascades from them: this function deletes from every table whose foreign key to profiles cascades.
-- The list is read from the catalog, so tables added by later migrations are covered without changes here.
--
-- Rows the student created inside a Turma subject stay with the Turma (the Turma owner takes them over, as on
-- account deletion); uploads to Turma subjects stay as they are. A student who owns a Turma must transfer it
-- first (owner_transfer_required). The returned storage paths are removed by the worker after the commit.

create or replace function private.reset_account(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fk record;
  v_documents jsonb;
  v_exports jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.class_groups where owner_id = p_user and deleted_at is null) then
    raise exception 'owner_transfer_required' using errcode = 'P0001';
  end if;

  -- Storage objects of the personal subjects' materials and of data exports (removed by the worker).
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'storage_path', d.storage_path)), '[]'::jsonb)
    into v_documents
    from public.documents d
    join public.subjects s on s.id = d.subject_id
   where s.owner_profile_id = p_user;
  select coalesce(jsonb_agg(e.storage_path), '[]'::jsonb)
    into v_exports
    from public.data_exports e
   where e.user_id = p_user and e.storage_path is not null;

  -- Turma subjects, notes and divide plans the student created keep working for the Turma.
  update public.subjects s
     set created_by = g.owner_id
    from public.class_groups g
   where s.created_by = p_user and s.owner_class_group_id = g.id;
  update public.notes n
     set created_by = g.owner_id
    from public.subjects s
    join public.class_groups g on g.id = s.owner_class_group_id
   where n.created_by = p_user and n.subject_id = s.id;
  update public.divide_plans p
     set created_by = g.owner_id
    from public.class_groups g
   where p.created_by = p_user and p.class_group_id = g.id;
  update public.class_group_members set approved_by = null where approved_by = p_user;
  delete from public.invites where created_by = p_user;

  -- Everything the student owns: every single-column foreign key to profiles that cascades on delete.
  -- Append-only tables (review_logs, xp_events, …) allow an account purge only with studify.allow_purge on,
  -- scoped to this transaction and switched off again right after.
  perform set_config('studify.allow_purge', 'on', true);
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'public.profiles'::regclass
       and c.confdeltype = 'c'
       and cardinality(c.conkey) = 1
     order by c.conrelid::regclass::text, a.attname
  loop
    execute format('delete from %s where %I = $1', fk.tbl, fk.col) using p_user;
  end loop;
  perform set_config('studify.allow_purge', 'off', true);

  -- Back to a fresh start: default settings and the onboarding again.
  update public.profiles
     set settings = '{}'::jsonb,
         onboarding_completed_at = null,
         foreign_language = null
   where id = p_user;

  return jsonb_build_object('documents', v_documents, 'exports', v_exports);
end;
$$;

revoke all on function private.reset_account(uuid) from public, anon, authenticated;
grant execute on function private.reset_account(uuid) to service_role;
