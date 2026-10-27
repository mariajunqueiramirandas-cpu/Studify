-- Foundation: extensions, private schema, UUID v7, updated_at trigger and RLS helpers.
-- Source: docs/engineering/data-model.md §1, §4 (header), §6.1; security-privacy.md §4.1.

create extension if not exists pgcrypto;
create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists citext;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- UUID v7 (RFC 9562, time-ordered). Postgres 16 has no built-in uuidv7(); this PL/pgSQL
-- version is used everywhere. When the platform moves to Postgres >= 18, the body can become
-- `select pg_catalog.uuidv7()` without touching any table default.
create or replace function public.uuid_v7() returns uuid
language plpgsql volatile parallel safe set search_path = '' as $$
declare
  v_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_b  bytea;
begin
  v_b := substring(int8send(v_ms) from 3 for 6)
      || substring(decode(replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 10);
  v_b := set_byte(v_b, 6, (get_byte(v_b, 6) & 15) | 112);   -- version 7
  v_b := set_byte(v_b, 8, (get_byte(v_b, 8) & 63) | 128);   -- RFC 4122 variant
  return encode(v_b, 'hex')::uuid;
end $$;

-- updated_at maintenance (data-model.md §1.1).
create or replace function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Immutable wrapper so unaccent can be used in generated columns and indexes (data-model §4 header).
create or replace function private.f_unaccent(text) returns text
  language sql immutable parallel safe strict
  as $$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Cast that returns NULL instead of failing; used by storage policies whose first path
-- segment may be a non-uuid (e.g. 'answers/...'). CASE-free, so policies stay short.
create or replace function private.try_uuid(p text) returns uuid
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- RLS helpers (data-model.md §6.1). They read public tables that are created in the core
-- migration, so body validation is deferred until those tables exist.
set check_function_bodies = off;

create or replace function private.is_member(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_group_members m
                 where m.class_group_id = p_group and m.user_id = auth.uid() and m.status = 'active');
$$;

create or replace function private.is_moderator(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_group_members m
                 where m.class_group_id = p_group and m.user_id = auth.uid()
                   and m.status = 'active' and m.role in ('owner','moderator'));
$$;

create or replace function private.can_read_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subjects s
                 where s.id = p_subject and s.deleted_at is null
                   and (s.owner_profile_id = auth.uid()
                        or (s.owner_class_group_id is not null and private.is_member(s.owner_class_group_id))));
$$;

-- personal owner; Turma owner/moderator; or the member who created the shared subject (SOC-01.10)
create or replace function private.can_edit_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subjects s
                 where s.id = p_subject and s.deleted_at is null
                   and (s.owner_profile_id = auth.uid()
                        or (s.owner_class_group_id is not null
                            and (private.is_moderator(s.owner_class_group_id)
                                 or (s.created_by = auth.uid() and private.is_member(s.owner_class_group_id))))));
$$;

create or replace function private.can_upload_to_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_edit_subject(p_subject) or exists (
    select 1 from public.subjects s join public.class_groups g on g.id = s.owner_class_group_id
    where s.id = p_subject and g.allow_member_uploads and private.is_member(g.id));
$$;

-- R8: an item is visible if its subject is readable and it is not someone else's personal item
create or replace function private.can_read_item(p_subject uuid, p_personal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_read_subject(p_subject) and (p_personal is null or p_personal = auth.uid());
$$;

create or replace function private.shares_class_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_group_members a join public.class_group_members b
                   on a.class_group_id = b.class_group_id
                 where a.user_id = auth.uid() and b.user_id = p_user and a.status = 'active' and b.status = 'active');
$$;

create or replace function private.is_app_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.app_role = 'app_admin');
$$;

-- Added for document_pages, document_slices, node_* and storage policies.
create or replace function private.can_read_document(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.documents d
                 where d.id = p_document and private.can_read_subject(d.subject_id));
$$;

create or replace function private.can_read_node(p_node uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.knowledge_nodes n
                 where n.id = p_node and private.can_read_subject(n.subject_id));
$$;

-- Added for policies that let the personal owner (and only them) edit a personal subject's items.
create or replace function private.owns_personal_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subjects s
                 where s.id = p_subject and s.owner_profile_id = auth.uid());
$$;

reset check_function_bodies;
