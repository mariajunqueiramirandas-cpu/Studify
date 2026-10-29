# Deployment

| | |
|---|---|
| **Status** | Ready to deploy (first production deploy pending) |
| **Scope** | The VPS (Dokploy): API, Postgres, files, backups; Supabase Auth; the public domain; the move from Supabase; updates, logs |
| **Related** | [Architecture](architecture.md) · [API](api.md) · [ADR 0008](adr/0008-vps-bun-hono-api.md) · [ADR 0010](adr/0010-direct-sse-api.md) · [ADR 0012](adr/0012-own-postgres-files-realtime.md) · [Mobile app](mobile-app.md) |

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| API server (`apps/api`, Bun + Hono) | **VPS**, Dokploy Compose app, service `api`, port 3000 | Serves `/api/<name>` (functions and data endpoints, all over SSE), `/api/realtime-stream`, `/api/storage/*`, `/api/health`, the link site and the dashboard. Applies pending migrations before it listens. |
| Postgres 17 | **VPS**, service `db`, volume `pgdata` | Studify's data. Reachable from the API only (network `internal`). Schema from `packages/db/migrations`. |
| Files | **VPS**, volume `files` at `/data/storage` in the API | One folder per bucket; metadata in `storage.objects`. |
| Backups | **VPS**, service `backup`, volume `backups` | Nightly `pg_dump` and a tarball of the files, kept 7 days. Copy them off the VPS (§5). |
| Accounts (sign-in codes, Google, sessions) | **Supabase Auth**, region sa-east-1 | The only part left on Supabase (ADR 0012). |
| Public domain | `studify.vendua.com.br` (HTTPS, Let's Encrypt via Dokploy) | The API is under `https://studify.vendua.com.br/api`. |

## 2. Supabase Auth

The Supabase project only provides accounts. Its database still holds `auth.users`; nothing of Studify's data.

1. **Auth settings** (Authentication > URL Configuration):
   - Site URL: `studify://auth/callback` (the app's deep link, mobile-app.md §2.3).
   - Redirect URLs: `studify://auth/callback` and `https://studify.vendua.com.br`.
2. **Google provider** (Authentication > Providers > Google): the OAuth client id and secret from the Google Cloud
   console (Web application client, the same one as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`).
   E-mail templates and the Resend sender are pushed from `supabase/config.toml` (apps/mobile/RELEASING.md §8).
3. **Keys for the API**: Project Settings > API: the project URL (`SUPABASE_URL`), the secret key
   (`SUPABASE_SERVICE_ROLE_KEY`, used to suspend, sign out and delete accounts) and the publishable key
   (`SUPABASE_ANON_KEY`).

The free tier pauses a project after about 7 days without activity. Every API call verifies its token with Supabase
Auth, so an app in use keeps it awake; if sign-in fails for everyone, check the project status first.

## 3. Dokploy (VPS)

1. **Create a Compose app**: Project > Create Service > Compose. Source: the Git repository and branch (for example
   `main`). Compose file: `docker-compose.yml` at the repository root. Build path: the repository root.
2. **Environment**: paste the variables from [`.env.example`](../../.env.example) into the app's Environment tab with
   real values. Dokploy writes them to `.env` next to the compose file, and the API reads it (`env_file`).
   Required: `POSTGRES_PASSWORD` (letters and digits, e.g. `openssl rand -hex 24`), `STORAGE_SIGNING_KEY`
   (`openssl rand -hex 32`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`.
   The compose file builds `DATABASE_URL` from `POSTGRES_PASSWORD`; do not set it. Keep `PORT=3000` and
   `BASE_URL=studify.vendua.com.br`. Set `RESEND_API_KEY` too, or guardian mails are not sent. Never commit real values.
   Keep `POSTGRES_PASSWORD` and `STORAGE_SIGNING_KEY` somewhere safe outside the VPS: the database keeps the password
   it was created with.
3. **Domain**: the Domains tab, add `studify.vendua.com.br`, service `api`, container port `3000`, HTTPS on
   (Let's Encrypt). Dokploy adds the Traefik routing; the compose file has the same labels commented out if you need
   them by hand.
4. **DNS**: an `A` record `studify.vendua.com.br` pointing to the VPS IP. Wait for it to resolve before enabling
   HTTPS.
5. **Deploy**. The image builds from the repository root (`apps/api/Dockerfile`) and runs `bun apps/api/src/server.ts`.
   Compose starts `db` first; the API waits for it to be healthy, applies the migrations (`schema ready` in the logs)
   and then listens.
6. **Check**: `curl https://studify.vendua.com.br/api/health` returns `{"ok":true,"version":"0.1.0"}`, and
   `https://studify.vendua.com.br/c/ABCDEFGH` returns the link page, and `https://studify.vendua.com.br/download` redirects to
   the newest `studify.apk`.

The compose file joins the API to the external `dokploy-network`, uses `expose` instead of host ports, and has
no `container_name`. Do not add published ports: Traefik reaches the API through the network, and Postgres is on the
`internal` network only. Traefik must not buffer `/api/*` responses: `realtime-stream` is a long-lived SSE response.

## 4. One SSE API service

- Run **one replica**, using **stop-first** deployment ordering. A session advisory lock prevents overlapping API owners. Scale the VPS before changing the live-stream ownership design.
- Apply `20261028040000_direct_sse_operations.sql` before deploying. On first migration from the queued architecture, drain or explicitly resolve the old backlog and outstanding provider batches, then stop the old worker and API. The new runtime does not consume the old pg-boss schema.
- Coordinate the API and new mobile build: legacy clients with 30-second JSON deadlines lose the old deferred polling contract. Ship the SSE-capable build as part of the cutover and enforce its minimum version once available.
- Remove `PG_BOSS_SCHEMA`, `AI_USE_BATCH` and `WORKER_LOG_LEVEL`; use `TASK_LOG_LEVEL`. Keep push, PDF, TTS and model settings on the API container. `PG_POOL_MAX` defaults to 12, with one connection reserved for ownership.
- `AI_WAVE_CONCURRENCY` (default 24) is the number of model calls material processing and the Trilha run at once on the whole server, not per material (ADR 0011). Set it from the Anthropic account's output-tokens-per-minute limit: a call writes about 250 tokens a second, so 24 calls are about 360k tokens a minute.
- SSE sends a heartbeat every 15 seconds. Verify Traefik forwards each frame immediately; disable buffering/compression middleware for `/api/*`, permit at least 45 seconds of network silence, and avoid absolute response timeouts below the operation duration. `X-Accel-Buffering: no` is also sent for proxies that honor it.
- SIGTERM drains connected and detached operations, then stops the scheduler and closes Postgres. Compose allows 60 seconds; the process forces exit at 50 seconds. Startup marks orphaned work interrupted so a student can retry from saved domain state.
- Only future calendar triggers are persisted in `private.scheduled_actions`; immediate work bypasses it. Unclaimed deadlines survive restarts. A trigger interrupted after claim is at most once and may require manual recovery; failures are logged, without automatic paid retries.
- The same container serves the web dashboard at `/painel` (`apps/dashboard`, built by the image's `dashboard` stage into `/app/dashboard`, `DASHBOARD_DIR`). It reuses `SUPABASE_URL` and `SUPABASE_ANON_KEY` (written into the page at serve time) and needs no extra variable or Auth setting: sign-in uses the 6-digit code already in the e-mail template. Apply `20261029120000_admin_dashboard.sql` before deploying it.
- Watch API event-loop delay, memory, active SSE connections and PDF processing load. See [ADR 0010](adr/0010-direct-sse-api.md) for transport limits and scaling constraints.
- Realtime (ADR 0012) lives in this process: each signed-in app holds one `realtime-stream`. A deploy or restart
  closes them; the apps reconnect, join their channels again and refetch. One extra Postgres connection LISTENs for
  row changes (`studify_row_changes`).
- Files are served by the API from the `files` volume through signed links (`/api/storage/object/...?token=`), which
  last an hour. Changing `STORAGE_SIGNING_KEY` ends the links already handed out.

## 5. Logs and health

- **API**: JSON lines on stdout (`{"time","level","msg",...}`). Each request logs method, path, status and
  milliseconds to response headers. Authorization headers and bodies are never logged. Errors and warnings go to
  stderr. Dokploy shows them under the service's Logs tab.
- **Domain operations**: pino JSON logs in the API (`service: studify-api-tasks`).
- **Health**: the image's HEALTHCHECK and the compose `healthcheck` call `/api/health` every 30 s. An unhealthy
  container is restarted by `restart: unless-stopped` only when the process exits; watch the Dokploy status for
  "unhealthy".
- **Backups**: the `backup` service logs `backup <stamp> done` (or `FAILED`) once a day and keeps
  `BACKUP_KEEP_DAYS` days (default 7) in the `backups` volume: `studify-<stamp>.dump` (`pg_dump --format=custom`) and
  `files-<stamp>.tar.gz`. **Copy them off the VPS** (for example a daily `rsync` or `rclone` of the volume's directory,
  `docker volume inspect <project>_backups`, to another machine or bucket): a backup on the same disk does not
  survive losing the disk. Most users are minors (LGPD); keep the copies encrypted and access-controlled.
- **Restore**: stop the API, then
  `docker compose exec -T db pg_restore --clean --if-exists -U studify -d studify < studify-<stamp>.dump`, and extract
  `files-<stamp>.tar.gz` into the `files` volume. Start the API.
- **Disk**: the database and the files share the VPS disk with the backups. Watch free space (`df -h`).

## 6. Updating

- **Code**: push to the deployed branch and redeploy from Dokploy (or enable auto-deploy with the Git webhook). The
  images rebuild from the lockfile (`pnpm install --frozen-lockfile`), so the same commit gives the same dependencies.
- **Schema**: new migrations go in `packages/db/migrations` (`<UTC timestamp>_<name>.sql`). The API applies pending
  ones at startup, each in one transaction, before it listens, and records them in `migrations.applied`. A failing
  migration is rolled back and stops the start (the logs name it). Deploys are stop-first (§4), so the API is down
  until you fix forward or redeploy the previous commit. Migrations are additive by convention
  (docs/engineering/data-model.md). By hand: `DATABASE_URL=... pnpm --filter @studify/db migrate`.
- **Rollback**: redeploy the previous commit in Dokploy. Migrations are not rolled back automatically.
- **Mobile**: the app's API base is `EXPO_PUBLIC_API_URL` (default `https://studify.vendua.com.br/api`). Expo
  bakes it into the bundle at build time, so changing the host needs a new build. `EXPO_PUBLIC_SUPABASE_URL` and the
  publishable key are only used for sign-in now.

## 7. Local development

```bash
pnpm install
cp .env.example .env            # fill in dev values; use a dev Claude key with a spend cap
pnpm api:dev                    # bun --watch apps/api/src/server.ts on PORT (default 3000)
pnpm api:test                   # bun test for apps/api
```

- Postgres: any local Postgres 15+ works, e.g. `docker run -d --name studify-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine`,
  with `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres`. The API migrates it on start. Do not
  point it at the Postgres of `supabase start`: that one already has Supabase's own `auth` schema.
- Auth: `supabase start` serves Supabase Auth at `http://127.0.0.1:54321` (Storage and Realtime are off in
  `supabase/config.toml`), or use a development Supabase project. Set `SUPABASE_URL` and the keys accordingly.
- Files: set `STORAGE_DIR` to a local directory and `STORAGE_SIGNING_KEY` to any 32+ characters; with an empty
  `BASE_URL`, signed links point at `http://localhost:<PORT>/api` (override with `PUBLIC_API_URL`, e.g.
  `http://10.0.2.2:3000/api` for the Android emulator).
- Database tests: `pnpm db:test` (pgTAP on a fresh database), `TEST_PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm --filter @studify/db test`
  (migration runner, query engine, file store), and the API integration tests with
  `RUNTIME_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/studify_test` (after `pnpm db:test`).
- For Claude calls without spend, run the mock server
  (`cd packages/ai && npx tsx src/mock/cli.ts --port 4010 --fixtures test/fixtures/claude`) and set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:4010`.
- The mobile app on the Android emulator reaches the local API at `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api`.
- The web dashboard: `pnpm --filter @studify/dashboard dev` with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set; `/api` is proxied to the local API on port 3000. `pnpm --filter @studify/dashboard build` writes `apps/dashboard/dist`, which `pnpm api:dev` serves at `/painel`.
- The images build with `docker compose build` from the repository root. A Docker daemon is needed.

## 8. Moving from Supabase (once)

The Supabase project held the data, files and realtime until ADR 0012. Move them once, in a quiet moment:

1. Deploy this version to Dokploy (§3) with all variables set. It starts with an empty, migrated database.
2. Stop the app's writes for the window (it is a pilot: tell the students), then copy everything from the Supabase
   project, with the **session pooler** string of the Supabase database as `SOURCE_DATABASE_URL`:
   ```bash
   docker compose exec -e SOURCE_DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres' \
     api bun packages/db/src/copy-from-supabase.ts
   ```
   It copies the accounts (into `auth.users`), every row of `public` and `private`, the file metadata and the files,
   and refuses a database that already has profiles. It prints a count per table.
3. Ship the app build of this version (its data, uploads and realtime go to the API). Older builds keep talking to
   Supabase's tables and stop seeing new data: raise the minimum version (`app_versions.blocks_older`) once the new
   build is out.
4. Sign in, open a material, a file and a battle or room. Then the Supabase project's tables can be left alone; only
   Auth is used. Students stay signed in (their Supabase sessions are unchanged).

## 9. Not yet verified

- The web dashboard: its image stage has not been built (no Docker daemon where it was written). The Vite build was served by the real API app (`createApp` with `mountDashboard`, real handlers, the `private.admin_*` functions on a seeded local Postgres) and driven in Chromium through every page, in light, dark and at phone width, with no console or CSP errors. Sign-in against the real Supabase project and the e-mail code from a browser are still to be tried once deployed.
- The images have not been built or deployed. The image layout (install with `--frozen-lockfile --prod`, then run
  from `/app`) was reproduced in a scratch copy and the previous servers started from it; the new single-service image still needs a deployment smoke test. The Dokploy domain and TLS steps
  follow Dokploy's documentation and have not run on the VPS.
- The `oven/bun:1.4-slim` base image's `bun` user is assumed for `USER bun`; confirm on the first build.
- ADR 0012 (own Postgres, files and realtime): the migrations, query engine, file store, storage routes, realtime
  hub, every data endpoint and the copy script ran against local Postgres 16 in tests; the compose stack (Postgres 17,
  volumes, backup job) has not been started and the copy has not run against the real Supabase project. Traefik's
  handling of the long-lived `realtime-stream` response is to be checked on the VPS.
