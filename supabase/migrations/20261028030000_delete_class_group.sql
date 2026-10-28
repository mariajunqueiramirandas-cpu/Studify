-- SOC-01.15: the owner deletes the Turma. It is a soft delete (deleted_at), like the other tables.
-- Every membership ends, so classmates lose access to the shared subjects at once (private.is_member
-- and private.can_read_subject both require an active membership), and the invite links stop working.
-- Shared subjects are left as they are: the offer-back-to-uploader flow of SOC-01.15 is not built yet.

create or replace function public.delete_class_group(p_class_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.class_group_members m
                  where m.class_group_id = p_class_group_id and m.user_id = v_uid
                    and m.status = 'active' and m.role = 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.class_groups set deleted_at = now()
   where id = p_class_group_id and deleted_at is null;
  update public.class_group_members set status = 'left', left_at = now()
   where class_group_id = p_class_group_id and status in ('active', 'pending');
  update public.invites set revoked_at = now()
   where class_group_id = p_class_group_id and revoked_at is null;
end $$;

revoke all on function public.delete_class_group(uuid) from public, anon;
grant execute on function public.delete_class_group(uuid) to authenticated;
