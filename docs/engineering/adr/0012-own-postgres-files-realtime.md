# 0012 — Own Postgres, files and realtime on the VPS; Supabase keeps only Auth

| Status | Accepted. Supersedes the database, Storage and Realtime parts of [ADR 0002](0002-supabase-backend.md). |
|---|---|
| Date | 2026-10-29 |
| Related | [ADR 0008](0008-vps-bun-hono-api.md) · [ADR 0010](0010-direct-sse-api.md) · [Deployment](../deployment.md) · [API](../api.md) · [Data model](../data-model.md) |

## Context

After ADR 0008 the API already ran on the owner's VPS, but Supabase still held the data (Postgres reached through
PostgREST), the files (Storage) and the live channels (Realtime). The owner wants the backend in one place they
control, without self-hosting the Supabase stack (about a dozen containers). The free tier also paused the project
after a week without traffic and capped the database at 500 MB and files at 1 GB.

The schema, its 237 row level security policies and the pgTAP suite are plain Postgres; only a small platform surface
(API roles, `auth.uid()`, the `storage` and `realtime` schemas) came from Supabase. The app read and wrote about 200
tables directly through supabase-js, and the API made about 830 supabase-js table calls.

## Decision

- **Postgres runs next to the API** (docker-compose `db` service, Postgres 17) with a data volume and a nightly
  backup job. The first migration (`20251231000000_platform.sql`) creates the platform surface the schema expects:
  roles `anon`/`authenticated`/`service_role`, `auth.users` (a copy of the accounts) with `auth.uid()`, `auth.jwt()`,
  `auth.role()`, `storage.buckets`/`objects` and `realtime.messages`/`topic()`. Every later migration and policy is
  unchanged. Migrations move to `packages/db/migrations` and the API applies pending ones at startup.
- **`@studify/db` replaces PostgREST for server code**: a query builder with the supabase-js call shape, compiled to
  SQL whose results Postgres serializes to JSON (as PostgREST did), so the handlers did not change. `db.asUser(claims)`
  runs statements as `authenticated` with the student's claims, so row level security applies.
- **The app has no direct database access.** Each of its former table queries is a named API endpoint (data routes,
  `apps/api/src/data`) that runs as the student, so the same policies decide what it reads and writes. Every call,
  data routes included, is answered over SSE (ADR 0010); reads stream without an idempotency record.
- **Files are on the API's disk** (a volume at `STORAGE_DIR`), with metadata in `storage.objects`. Student uploads
  (standard and TUS resumable, the protocol the app already spoke) are authorized by the storage policies, run as the
  student. Downloads use HMAC-signed links (`storage-sign`, also answered over SSE) with Range support.
- **Realtime is one SSE stream per app** (`realtime-stream`), with `realtime-join`, `realtime-leave` and
  `realtime-track` as SSE calls. Private channels and presence follow the realtime policies. Row changes come from
  triggers (`pg_notify` on `studify_row_changes`), and each is re-read as the subscriber before it is sent.
- **Supabase keeps Auth only**: sign-in codes, Google sign-in and sessions. The API verifies tokens with Supabase Auth
  and keeps `auth.users` current (email, last sign-in, suspension); deleting an account deletes the local row too.

## Alternatives considered

| Option | Why not |
|---|---|
| **Self-host the Supabase stack** | Keeps the code as it was, but adds about a dozen containers (gateway, PostgREST, Storage, Realtime, Studio, …) and their upgrades. The owner asked not to. |
| **PostgREST as its own container** | Least code for the app's queries, but another service, and the app would still query tables directly. The owner chose dedicated endpoints. |
| **A generic query endpoint in the API** | Fewer endpoints, but the app would keep building queries against table names; dedicated endpoints give the API a fixed surface it can test and evolve. |
| **WebSockets for realtime** | Works, but every other call already uses SSE; one transport is simpler for the app and for proxies (ADR 0010). |
| **MinIO or another S3 store for files** | One more service for a few gigabytes. Disk plus metadata in Postgres is enough at this size; the file store has one interface if that changes. |
| **Move Auth too** | Sign-in codes, Google sign-in, sessions and refresh tokens are the riskiest code to own, and most users are minors. Supabase Auth stays until there is a reason to move it. |

## Consequences

- **+** One VPS holds the data, files and realtime; no pause after a quiet week, no free-tier caps.
- **+** The policies and the pgTAP suite are unchanged and still decide every student read and write; a smoke test
  runs every data endpoint against the migrated schema in CI.
- **+** The app talks to one API over one transport (SSE).
- **−** Backups, Postgres upgrades and disk space are the owner's job. The compose file keeps seven nightly backups on
  the same VPS; copying them elsewhere is required (deployment.md §5).
- **−** The realtime hub lives in the one API process (ADR 0010's single replica). A restart drops streams; apps
  reconnect and join again, and miss changes made while they were away (screens refetch).
- **−** Each new screen query needs an endpoint instead of a client-side query.
- **−** Accounts and data live in two places. The local `auth.users` copy is updated on each verified token, ban and
  deletion; an account changed only on the Supabase side shows up locally at the student's next call.
