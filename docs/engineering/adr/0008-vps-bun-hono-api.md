# 0008 — API server on a VPS with Bun and Hono (Supabase Edge Functions retired)

| Status | Accepted. Supersedes the Edge Functions part of [ADR 0002](0002-supabase-backend.md). |
|---|---|
| Date | 2026-10-27 |
| Related | [Architecture](../architecture.md) · [API](../api.md) · [Deployment](../deployment.md) · [ADR 0005](0005-job-worker-pg-boss.md) |

## Context

The app's synchronous server functions (sync push, tutor streaming, grading, quiz assembly, duels and battles,
share links) ran as about 35 Supabase Edge Functions written for Deno. Three things made that a poor fit:

- **Limits.** Edge Functions have a 2 s CPU budget per request and a wall-clock cap (150 s free, 400 s paid). Tutor
  streams and AI calls are long and bursty, and the worker already exists for the heavy work (ADR 0005).
- **Two runtimes.** The shared code had to build for Deno (`npm:` and `jsr:` specifiers, a `deno.json` import map,
  `Deno.serve` entry points) and for Node (the worker, the app). Tests ran under `deno test` in their own CI job.
- **Operations.** The team wants one place to see logs, health and deploys for the backend, and the owner has a VPS
  with Dokploy (Docker Compose deploys, Traefik, Let's Encrypt) that already hosts the public link site.

Supabase stays for Postgres, Auth, Storage and Realtime. The free tier is enough for the first users (see
[deployment.md](../deployment.md)).

## Decision

- The synchronous API is one **Bun + Hono** server in `apps/api`. Each former Edge Function is a module in
  `apps/api/src/functions/<name>.ts` exporting the same `handler(req, deps)`. The server routes `/api/<name>` to it.
  Request and response behaviour (CORS, 401/405/426 envelopes, Idempotency-Key replay, SSE) is unchanged.
- The server runs on the owner's **VPS through Dokploy** as a Docker Compose app built from this repository
  (`docker-compose.yml`, `apps/api/Dockerfile`, `apps/worker/Dockerfile`). The public domain is
  `studify.vendua.com.br`; the same container serves the static link site (`apps/site/public`) and `/api`.
- The **worker moves to Bun as well** (checked locally: pg-boss 12, pdfjs-dist legacy build and @napi-rs/canvas
  run under Bun). The worker's own tests stay on Vitest under Node.
- **pg-boss enqueue** uses the real pg-boss client (same version as the worker) started with `supervise`,
  `schedule` and `migrate` off, so the worker keeps owning the schema. This replaces the hand-written SQL INSERT
  (ADR 0005 is unchanged).
- Supabase keeps Postgres, Auth, Storage and Realtime. `DATABASE_URL` is the **session pooler** (port 5432), which
  pg-boss needs.
- The mobile app calls `EXPO_PUBLIC_API_URL` (default `https://studify.vendua.com.br/api`) instead of
  `<supabase>/functions/v1`. Auth is still the Supabase JWT in the `Authorization` header.
- `supabase/functions`, the Deno tooling and the Edge Functions section of `supabase/config.toml` are removed.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep Supabase Edge Functions** | The limits above, two runtimes, and no single place for logs and deploys. |
| **Node (Hono on `@hono/node-server`) instead of Bun** | Works, but the owner asked for Bun, and Bun runs the shared TypeScript sources and pg-boss without a build step. The worker also runs on Bun now. |
| **Cloud Run / Fly.io / Render / Railway** | Would work. A VPS already exists, and Dokploy gives Compose deploys and TLS in one place. Revisit if the VPS becomes the bottleneck. |
| **Keep the SQL INSERT enqueue** | Works, but it copies pg-boss internals and drifts from the worker's version. The real client runs under Bun (checked). |

## Consequences

- **+** No function wall-clock cap. SSE streams and AI calls run as long as the request needs (the server allows an
  idle connection for up to 255 s; heartbeats keep streams alive).
- **+** One runtime (Bun) for the API and the worker. One lockfile, one typecheck, one `bun test` job in CI.
- **+** Deploys, logs and health checks in one Dokploy app. Rollback is a redeploy of a previous commit.
- **−** The VPS is now part of the availability story. A host failure takes the API down until it is restored;
  backups of the VPS config and the `.env` values are the owner's responsibility.
- **−** The API no longer gets Supabase's managed TLS and scaling. Scale vertically first; the worker runs as a single
  replica (ADR 0005).
- **−** The database must be reachable from the VPS over IPv4, so the session pooler connection string is required
  (the free tier's direct connection is IPv6-only).
- **−** Two Dockerfiles and one compose file to keep in step with the workspace. Images are not built in the
  development sandbox; the first real build happens on Dokploy.
