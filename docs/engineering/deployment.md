# Deployment

| | |
|---|---|
| **Status** | Ready to deploy (first production deploy pending) |
| **Scope** | Supabase cloud project, the API and worker on the VPS (Dokploy), the public domain, updates, logs |
| **Related** | [Architecture](architecture.md) · [API](api.md) · [ADR 0008](adr/0008-vps-bun-hono-api.md) · [ADR 0005](adr/0005-job-worker-pg-boss.md) · [Mobile app](mobile-app.md) |

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Postgres, Auth, Storage, Realtime | **Supabase cloud**, free tier, region **sa-east-1 (São Paulo)** (SP-16) | Schema comes from `supabase/migrations`. |
| API server (`apps/api`, Bun + Hono) | **VPS**, Dokploy Compose app, service `api`, port 3000 | Serves `/api/<name>`, `/api/health`, the React link site (`apps/site`, built into the image) at `/`, `/c/*`, `/i/*`, `/q/*`, `/b/*`, `/assets/*`, `/.well-known/assetlinks.json`, and `/download` (302 to the newest release APK; `APK_URL` overrides it). |
| Worker (`apps/worker`, Bun + pg-boss) | VPS, same Compose app, service `worker` | No domain. One replica. |
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
5. **Database URL for the API and worker**: Project Settings > Database > **Session pooler**, port **5432**.
   Use this string as `DATABASE_URL`. Do not use the transaction pooler (6543): pg-boss needs session mode. Do not
   use the direct connection either: on the free tier it is IPv6-only, and the VPS needs IPv4.

Free-tier limits to keep in mind:
- 500 MB database, 1 GB file storage, 50,000 monthly active users.
- The project **pauses after about 7 days without activity**. Restore it from the dashboard. A paused project makes
  every API call fail, so check the project status when the API returns 5xx for everything.

## 3. Dokploy (VPS)

1. **Create a Compose app**: Project > Create Service > Compose. Source: the Git repository and branch (for example
   `main`). Compose file: `docker-compose.yml` at the repository root. Build path: the repository root.
2. **Environment**: paste the variables from [`.env.example`](../../.env.example) into the app's Environment tab with
   real values. Dokploy writes them to `.env` next to the compose file, and both services read it (`env_file`).
   Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`.
   Keep `PORT=3000` and `BASE_URL=studify.vendua.com.br`. Set `RESEND_API_KEY` too, or guardian mails are not sent.
   Never commit real values.
3. **Domain**: the Domains tab, add `studify.vendua.com.br`, service `api`, container port `3000`, HTTPS on
   (Let's Encrypt). Dokploy adds the Traefik routing; the compose file has the same labels commented out if you need
   them by hand.
4. **DNS**: an `A` record `studify.vendua.com.br` pointing to the VPS IP. Wait for it to resolve before enabling
   HTTPS.
5. **Deploy**. Both images build from the repository root (`apps/api/Dockerfile`, `apps/worker/Dockerfile`).
   The API image runs `bun apps/api/src/server.ts`; the worker image runs `bun apps/worker/src/index.ts`.
6. **Check**: `curl https://studify.vendua.com.br/api/health` returns `{"ok":true,"version":"0.1.0"}`, and
   `https://studify.vendua.com.br/c/ABCDEFGH` returns the link page, and `https://studify.vendua.com.br/download` redirects to
   the newest `studify.apk`.

The compose file joins both services to the external `dokploy-network`, uses `expose` instead of host ports, and has
no `container_name`. Do not add published ports: Traefik reaches the API through the network.

## 4. Worker

- **Run one replica.** ADR 0005 keeps one worker instance with per-queue concurrency limits. Scale the VPS up before
  adding replicas.
- **Stop gracefully.** The compose file gives the worker 60 s (`stop_grace_period`). On SIGTERM it stops pg-boss and
  lets in-flight jobs finish, so a deploy does not kill a running ingest.
- **Schema.** The worker creates the `pgboss` schema and its queues on first start. The API only sends jobs, so
  deploy the worker before the first API request that enqueues a job (the API retries pg-boss start on each enqueue,
  so the order is forgiving).

## 5. Logs and health

- **API**: JSON lines on stdout (`{"time","level","msg",...}`). Each request logs method, path, status and
  milliseconds to response headers. Authorization headers and bodies are never logged. Errors and warnings go to
  stderr. Dokploy shows them under the service's Logs tab.
- **Worker**: pino JSON logs (`service: studify-worker`).
- **Health**: the image's HEALTHCHECK and the compose `healthcheck` call `/api/health` every 30 s. An unhealthy
  container is restarted by `restart: unless-stopped` only when the process exits; watch the Dokploy status for
  "unhealthy".

## 6. Updating

- **Code**: push to the deployed branch and redeploy from Dokploy (or enable auto-deploy with the Git webhook). The
  images rebuild from the lockfile (`pnpm install --frozen-lockfile`), so the same commit gives the same dependencies.
- **Schema**: CI applies new migrations to production on every push to `main` (job *Apply migrations to production*
  in `.github/workflows/ci.yml`), after the schema builds from scratch and the pgTAP suite and RLS gate pass on that
  commit. It runs `supabase db push`, which applies only the migrations production has not recorded, so a push
  without new migrations changes nothing. Setup, once:
  1. GitHub → Settings → Environments → **New environment** `production` (optionally add yourself as a required
     reviewer, so every production migration waits for a click).
  2. In that environment add the secret **`SUPABASE_DB_URL`**: the **Session pooler** connection string (port
     5432, user `postgres.<project-ref>`) with the database password. GitHub runners have no IPv6, so the direct
     `db.<ref>.supabase.co` host does not work.
  Migrations are additive by convention (docs/engineering/data-model.md), so the code deploy can run alongside;
  when a migration must land first, merge it in its own PR before the code. Never apply a migration by hand (SQL
  editor, MCP): it is recorded under a different version and the next `db push` stops on the mismatch (fix with
  `supabase migration repair`).
- **Rollback**: redeploy the previous commit in Dokploy. Migrations are not rolled back automatically.
- **Mobile**: the app's API base is `EXPO_PUBLIC_API_URL` (default `https://studify.vendua.com.br/api`). Expo
  bakes it into the bundle at build time, so changing the host needs a new build.

## 7. Local development

```bash
pnpm install
cp .env.example .env            # fill in dev values; use a dev Claude key with a spend cap
pnpm api:dev                    # bun --watch apps/api/src/server.ts on PORT (default 3000)
pnpm api:test                   # bun test for apps/api
pnpm --filter @studify/worker dev
```

- Local Supabase (`supabase start`) provides Postgres, Auth and Storage at `http://127.0.0.1:54321`. Use its
  connection string for `DATABASE_URL` (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
- For Claude calls without spend, run the mock server
  (`cd packages/ai && npx tsx src/mock/cli.ts --port 4010 --fixtures test/fixtures/claude`) and set
  `ANTHROPIC_BASE_URL=http://127.0.0.1:4010`.
- The mobile app on the Android emulator reaches the local API at `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api`.
- The images build with `docker compose build` from the repository root. A Docker daemon is needed.

## 8. Not yet verified

- The images have not been built or deployed. The image layout (install with `--frozen-lockfile --prod`, then run
  from `/app`) was reproduced in a scratch copy and both servers started from it. The Dokploy domain and TLS steps
  follow Dokploy's documentation and have not run on the VPS.
- The `oven/bun:1.4-slim` base image's `bun` user is assumed for `USER bun`; confirm on the first build.
