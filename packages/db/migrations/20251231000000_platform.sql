-- Platform: what the schema expects from the database before the first table exists (ADR 0012).
-- The schema was written for Supabase, whose Postgres comes with API roles, an auth schema, a storage schema and
-- Realtime authorization. Studify's own Postgres has none of that, so this migration creates the same names on a
-- plain Postgres, and every later migration, policy and pgTAP test runs unchanged:
--   * the roles anon, authenticated and service_role. The API runs a student's queries as `authenticated` with
--     the student's claims in request.jwt.claims (packages/db/src/client.ts), so row level security decides what
--     each student sees, exactly as before;
--   * auth.users, a local copy of the accounts that Supabase Auth still owns (the API keeps it current), and
--     auth.uid() / auth.jwt() / auth.role() reading the claims;
--   * storage.buckets / storage.objects, the metadata of the files the API keeps on disk. The storage policies
--     decide who may upload and read each file;
--   * realtime.messages / realtime.topic(), against which the realtime policies decide who may join a channel.
-- pgcrypto lives in the extensions schema, as on Supabase. Idempotent: roles are shared by every database of the
-- cluster, so they are created only when missing.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- Roles belong to the whole cluster, so these run only when needed: another database migrating at the same time
-- would otherwise update the same catalog rows.
do $$
begin
  if not (select rolbypassrls from pg_roles where rolname = 'service_role') then
    alter role service_role bypassrls;
  end if;
end $$;

-- The API connects as the database owner and switches to these roles per transaction (set_config('role', ...)).
-- A superuser can always switch; a non-superuser owner needs the memberships.
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user)
     and not (pg_has_role(current_user, 'anon', 'member') and pg_has_role(current_user, 'authenticated', 'member')
              and pg_has_role(current_user, 'service_role', 'member')) then
    execute format('grant anon, authenticated, service_role to %I', current_user);
  end if;
exception when others then
  raise notice 'could not grant the API roles to %: %', current_user, sqlerrm;
end $$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists realtime;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema realtime to anon, authenticated, service_role;

-- The API roles get table and function privileges in public; row level security does the filtering.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- auth.users: the accounts of Supabase Auth, as far as the schema needs them. The API writes a row the first time
-- it verifies a student's token and keeps email, last sign-in and suspension current (apps/api/src/shared/auth.ts);
-- deleting an account deletes the row, and the foreign keys cascade from it as they did on Supabase.
-- Column names and types follow Supabase Auth, so the data copy (scripts/copy-from-supabase.ts) maps one to one.
create table if not exists auth.users (
  id              uuid primary key,
  email           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_sign_in_at timestamptz,
  banned_until    timestamptz
);
create index if not exists users_email_idx on auth.users (lower(email));
revoke all on auth.users from anon, authenticated, service_role;

-- The caller's claims, as the API sets them for a student's transaction: request.jwt.claims (JSON), with the
-- older per-claim settings still read first so policies behave the same whichever form a caller uses.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')), '')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  auth.jwt() ->> 'sub')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  auth.jwt() ->> 'role')::text
$$;

-- storage: one row per stored file. The bytes are on the API's disk under <STORAGE_DIR>/<bucket>/<name>
-- (packages/db/src/storage.ts); metadata holds size, mimetype and eTag.
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null unique,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets(id),
  name             text,
  owner            uuid,
  metadata         jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  unique (bucket_id, name)
);
create index if not exists objects_bucket_prefix_idx on storage.objects (bucket_id, name text_pattern_ops);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Path segments without the file name: 'a/b/c.pdf' -> {a,b}. The storage policies authorize on them.
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select coalesce((string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1], '{}'::text[])
$$;

-- realtime: the realtime policies (select = may receive on a channel, insert = may send presence) are checked
-- against this table with realtime.topic() set to the channel (apps/api/src/realtime). No message is stored.
create table if not exists realtime.messages (
  id          bigint generated by default as identity primary key,
  topic       text not null,
  extension   text not null,
  event       text,
  payload     jsonb,
  private     boolean not null default false,
  inserted_at timestamp not null default now(),
  updated_at  timestamp not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated, service_role;

create or replace function realtime.topic() returns text
language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;
