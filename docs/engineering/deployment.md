# Deployment

| | |
|---|---|
| **Status** | Ready to deploy (first production deploy pending) |
| **Scope** | Supabase cloud project, the SSE API on the VPS (Dokploy), the public domain, updates, logs |
| **Related** | [Architecture](architecture.md) · [API](api.md) · [ADR 0008](adr/0008-vps-bun-hono-api.md) · [ADR 0010](adr/0010-direct-sse-api.md) · [Mobile app](mobile-app.md) |

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Postgres, Auth, Storage, Realtime | **Supabase cloud**, free tier, region **sa-east-1 (São Paulo)** (SP-16) | Schema comes from `supabase/migrations`. |
| API server (`apps/api`, Bun + Hono) | **VPS**, Dokploy Compose app, service `api`, port 3000 | Serves `/api/<name>`, `/api/health`, the React link site (`apps/site`, built into the image) at `/`, `/c/*`, `/i/*`, `/q/*`, `/b/*`, `/assets/*`, `/.well-known/assetlinks.json`, and `/download` (302 to the newest release APK; `APK_URL` overrides it). |
| Public domain | `studify.vendua.com.br` (HTTPS, Let's Encrypt via Dokploy) | The API is under `https://studify.vendua.com.br/api`. |

## 2. Supabase cloud (free tier)

1. **Create the project** in São Paulo (`sa-east-1`). Note the project ref and the database password.
2. **Apply the schema** from your machine:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   ```
   Migrations include the Storage buckets. Nothing is created by hand.
3. **Auth settings** (Authentication > URL Configuration):
   - Site URL: `studify://auth/callback` (the app's deep link, mobile-app.md §2.3).
   - Redirect URLs: `studify://auth/callback` and `https://studify.vendua.com.br`.
4. **Google provider** (Authentication > Providers > Google): enter the OAuth client id and secret from the Google
   Cloud console (Web application client, the same one as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`).
   E-mail templates and the Resend sender are pushed from `supabase/config.toml` (apps/mobile/RELEASING.md §8).
5. **Database URL for the API**: Project Settings > Database > **Session pooler**, port **5432**.
   Use this string as `DATABASE_URL`. Do not use the transaction pooler (6543): the API holds a session advisory lock. Do not
   use the direct connection either: on the free tier it is IPv6-only, and the VPS needs IPv4.

Free-tier limits to keep in mind:
- 500 MB database, 1 GB file storage, 50,000 monthly active users.
- The project **pauses after about 7 days without activity**. Restore it from the dashboard. A paused project makes
  every API call fail, so check the project status when the API returns 5xx for everything.

## 3. Dokploy (VPS)

1. **Create a Compose app**: Project > Create Service > Compose. Source: the Git repository and branch (for example
   `main`). Compose file: `docker-compose.yml` at the repository root. Build path: the repository root.
2. **Environment**: paste the variables from [`.env.example`](../../.env.example) into the app's Environment tab with
   real values. Dokploy writes them to `.env` next to the compose file, and the API reads it (`env_file`).
   Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`.
   Keep `PORT=3000` and `BASE_URL=studify.vendua.com.br`. Set `RESEND_API_KEY` too, or guardian mails are not sent.
   Never commit real values.
3. **Domain**: the Domains tab, add `studify.vendua.com.br`, service `api`, container port `3000`, HTTPS on
   (Let's Encrypt). Dokploy adds the Traefik routing; the compose file has the same labels commented out if you need
   them by hand.
4. **DNS**: an `A` record `studify.vendua.com.br` pointing to the VPS IP. Wait for it to resolve before enabling
   HTTPS.
5. **Deploy**. The single image builds from the repository root (`apps/api/Dockerfile`) and runs `bun apps/api/src/server.ts`.
6. **Check**: `curl https://studify.vendua.com.br/api/health` returns `{"ok":true,"version":"0.1.0"}`, and
   `https://studify.vendua.com.br/c/ABCDEFGH` returns the link page, and `https://studify.vendua.com.br/download` redirects to
   the newest `studify.apk`.

The compose file joins the API to the external `dokploy-network`, uses `expose` instead of host ports, and has
no `container_name`. Do not add published ports: Traefik reaches the API through the network.

## 4. One SSE API service

- Run **one replica**, using **stop-first** deployment ordering. A session advisory lock prevents overlapping API owners. Scale the VPS before changing the live-stream ownership design.
- Apply `20261028040000_direct_sse_operations.sql` before deploying. On first migration from the queued architecture, drain or explicitly resolve the old backlog and outstanding provider batches, then stop the old worker and API. The new runtime does not consume the old pg-boss schema.
- Coordinate the API and new mobile build: legacy clients with 30-second JSON deadlines lose the old deferred polling contract. Ship the SSE-capable build as part of the cutover and enforce its minimum version once available.
- Remove `PG_BOSS_SCHEMA`, `AI_USE_BATCH` and `WORKER_LOG_LEVEL`; use `TASK_LOG_LEVEL`. Keep push, PDF, TTS and model settings on the API container. `PG_POOL_MAX` defaults to 12, with one connection reserved for ownership.
- SSE sends a heartbeat every 15 seconds. Verify Traefik forwards each frame immediately; disable buffering/compression middleware for `/api/*`, permit at least 45 seconds of network silence, and avoid absolute response timeouts below the operation duration. `X-Accel-Buffering: no` is also sent for proxies that honor it.
- SIGTERM drains connected and detached operations, then stops the scheduler and closes Postgres. Compose allows 60 seconds; the process forces exit at 50 seconds. Startup marks orphaned work interrupted so a student can retry from saved domain state.
- Only future calendar triggers are persisted in `private.scheduled_actions`; immediate work bypasses it. Unclaimed deadlines survive restarts. A trigger interrupted after claim is at most once and may require manual recovery; failures are logged, without automatic paid retries.
- The same container serves the web dashboard at `/painel` (`apps/dashboard`, built by the image's `dashboard` stage into `/app/dashboard`, `DASHBOARD_DIR`). It reuses `SUPABASE_URL` and `SUPABASE_ANON_KEY` (written into the page at serve time) and needs no extra variable or Auth setting: sign-in uses the 6-digit code already in the e-mail template. Apply `20261029120000_admin_dashboard.sql` before deploying it.
- Watch API event-loop delay, memory, active SSE connections and PDF processing load. See [ADR 0010](adr/0010-direct-sse-api.md) for transport limits and scaling constraints.

## 5. Logs and health

- **API**: JSON lines on stdout (`{"time","level","msg",...}`). Each request logs method, path, status and
  milliseconds to response headers. Authorization headers and bodies are never logged. Errors and warnings go to
  stderr. Dokploy shows them under the service's Logs tab.
- **Domain operations**: pino JSON logs in the API (`service: studify-api-tasks`).
- **Health**: the image's HEALTHCHECK and the compose `healthcheck` call `/api/health` every 30 s. An unhealthy
  container is restarted by `restart: unless-stopped` only when the process exits; watch the Dokploy status for
  "unhealthy".

## 6. Updating

- **Code**: push to the deployed branch and redeploy from Dokploy (or enable auto-deploy with the Git webhook). The
  images rebuild from the lockfile (`pnpm install --frozen-lockfile`), so the same commit gives the same dependencies.
- **Schema**: apply new migrations with `supabase db push` **before** deploying code that needs them. Migrations are
  additive by convention (docs/engineering/data-model.md).
- **Rollback**: redeploy the previous commit in Dokploy. Migrations are not rolled back automatically.
- **Mobile**: the app's API base is `EXPO_PUBLIC_API_URL` (default `https://studify.vendua.com.br/api`). Expo
  bakes it into the bundle at build time, so changing the host needs a new build.

## 7. Local development

```bash
pnpm install
cp .env.example .env            # fill in dev values; use a dev Claude key with a spend cap
pnpm api:dev                    # bun --watch apps/api/src/server.ts on PORT (default 3000)
pnpm api:test                   # bun test for apps/api
```

- Local Supabase (`supabase start`) provides Postgres, Auth and Storage at `http://127.0.0.1:54321`. Use its
  connection string for `DATABASE_URL` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
- For Claude calls without spend, run the mock server
  (`cd packages/ai && npx tsx src/mock/cli.ts --port 4010 --fixtures test/fixtures/claude`) and set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:4010`.
- The mobile app on the Android emulator reaches the local API at `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api`.
- The web dashboard: `pnpm --filter @studify/dashboard dev` with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set; `/api` is proxied to the local API on port 3000. `pnpm --filter @studify/dashboard build` writes `apps/dashboard/dist`, which `pnpm api:dev` serves at `/painel`.
- The images build with `docker compose build` from the repository root. A Docker daemon is needed.

## 8. Not yet verified

- The web dashboard: its image stage has not been built (no Docker daemon where it was written). The Vite build was served by the real API app (`createApp` with `mountDashboard`, real handlers, the `private.admin_*` functions on a seeded local Postgres) and driven in Chromium through every page, in light, dark and at phone width, with no console or CSP errors. Sign-in against the real Supabase project and the e-mail code from a browser are still to be tried once deployed.
- The images have not been built or deployed. The image layout (install with `--frozen-lockfile --prod`, then run
  from `/app`) was reproduced in a scratch copy and the previous servers started from it; the new single-service image still needs a deployment smoke test. The Dokploy domain and TLS steps
  follow Dokploy's documentation and have not run on the VPS.
- The `oven/bun:1.4-slim` base image's `bun` user is assumed for `USER bun`; confirm on the first build.
