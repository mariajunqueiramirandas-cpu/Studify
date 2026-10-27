-- Test-only helpers for the pgTAP suite. Applied by run.sh after the shim and the migrations.
-- Not a migration and not matched by *.test.sql.

create schema if not exists test_helpers;

-- Runs p_sql as p_role with the JWT claims of p_uid (NULL = anonymous). Returns
-- {"rows": <rows returned or affected>, "err": <sqlstate + message, or null>}.
-- The role is always reset, even when the statement fails.
create or replace function test_helpers.try_as(p_role text, p_uid uuid, p_sql text)
returns jsonb
language plpgsql as $$
declare
  v_rows bigint := 0;
  v_err  text := null;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', p_role, 'sub', p_uid)::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
  exception when others then
    v_err := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  return jsonb_build_object('rows', v_rows, 'err', v_err);
end $$;

-- Single text value of an expression, evaluated as p_role. Errors propagate.
create or replace function test_helpers.scalar_as(p_role text, p_uid uuid, p_expr text)
returns text
language plpgsql as $$
declare
  v text;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('role', p_role, 'sub', p_uid)::text, true);
  execute format('set local role %I', p_role);
  begin
    execute 'select (' || p_expr || ')::text' into v;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
  return v;
end $$;

-- pgTAP-style assertions. Descriptions must not contain '#' or newlines (TAP).
create or replace function test_helpers.clean(p text) returns text
language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '[#\r\n]+', ' ', 'g')
$$;

-- The statement succeeds and returns / affects exactly p_rows rows.
create or replace function test_helpers.check_rows(p_desc text, p_role text, p_uid uuid, p_sql text, p_rows bigint)
returns text
language plpgsql as $$
declare
  r jsonb := test_helpers.try_as(p_role, p_uid, p_sql);
begin
  return public.ok(
    r->>'err' is null and (r->>'rows')::bigint = p_rows,
    test_helpers.clean(p_desc) || case when r->>'err' is null then ' (rows=' || (r->>'rows') || ')'
                                       else ' (error: ' || (r->>'err') || ')' end);
end $$;

-- The statement is refused (permission denied, RLS WITH CHECK, guard trigger, RPC check, ...).
create or replace function test_helpers.check_err(p_desc text, p_role text, p_uid uuid, p_sql text)
returns text
language plpgsql as $$
declare
  r jsonb := test_helpers.try_as(p_role, p_uid, p_sql);
begin
  return public.ok(r->>'err' is not null, test_helpers.clean(p_desc));
end $$;

-- The statement succeeds (any row count).
create or replace function test_helpers.check_ok(p_desc text, p_role text, p_uid uuid, p_sql text)
returns text
language plpgsql as $$
declare
  r jsonb := test_helpers.try_as(p_role, p_uid, p_sql);
begin
  return public.ok(r->>'err' is null,
                   test_helpers.clean(p_desc) || case when r->>'err' is not null then ' (error: ' || (r->>'err') || ')' else '' end);
end $$;

-- A scalar expression, evaluated as p_role, equals p_expected.
create or replace function test_helpers.check_scalar(p_desc text, p_role text, p_uid uuid, p_expr text, p_expected text)
returns text
language plpgsql as $$
declare
  v text;
begin
  begin
    v := test_helpers.scalar_as(p_role, p_uid, p_expr);
  exception when others then
    return public.ok(false, test_helpers.clean(p_desc) || ' (error: ' || sqlerrm || ')');
  end;
  return public.ok(v is not distinct from p_expected,
                   test_helpers.clean(p_desc) || ' (got ' || coalesce(v, 'NULL') || ')');
end $$;

-- The statement raises SQLSTATE p_state (superuser context; the failing statement is rolled back).
create or replace function test_helpers.check_sqlstate(p_desc text, p_sql text, p_state text)
returns text
language plpgsql as $$
declare
  v text := null;
begin
  begin
    execute p_sql;
  exception when others then
    v := sqlstate;
  end;
  return public.ok(v is not distinct from p_state,
                   test_helpers.clean(p_desc) || ' (sqlstate ' || coalesce(v, 'none') || ')');
end $$;
