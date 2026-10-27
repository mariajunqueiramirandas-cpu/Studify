#!/usr/bin/env bash
# Local database test run (no Docker): fresh database, Supabase shim, every migration in order,
# then the pgTAP suite. Exits non-zero on the first failing step or failing test.
#
# Connection: standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD). Defaults target the
# local PostgreSQL at postgres:postgres@localhost:5432.
set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="${STUDIFY_TEST_DB:-studify_test}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPA="$(cd "$HERE/.." && pwd)"

shopt -s nullglob
migrations=("$SUPA"/migrations/*.sql)
tests=("$HERE"/*.test.sql)
if [ "${#migrations[@]}" -eq 0 ]; then
  echo "no migrations found in $SUPA/migrations" >&2
  exit 1
fi
if [ "${#tests[@]}" -eq 0 ]; then
  echo "no pgTAP files found in $HERE" >&2
  exit 1
fi

echo "== recreate database $DB"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB with (force);"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $DB;"

echo "== pgTAP extension"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "create extension if not exists pgtap with schema public;"

echo "== shim (not a migration)"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/00_supabase_shim.sql"

echo "== migrations"
# Lexical order is the apply order (timestamp-prefixed names). Each file runs in one transaction.
for f in $(printf '%s\n' "${migrations[@]}" | sort); do
  echo "   apply $(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done

echo "== test helpers"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/_helpers.sql"

echo "== pgTAP"
pg_prove --timer -d "$DB" "${tests[@]}"
