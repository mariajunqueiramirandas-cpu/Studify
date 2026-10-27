# 0005 — Node.js job worker with pg-boss (hosting open)

| Status | Accepted (hosting choice: **open**) |
|---|---|
| Date | 2026-10-26 |
| Related | [Architecture](../architecture.md) · [API](../api.md) · [AI pipeline](../ai-pipeline.md) · [ADR 0002](0002-supabase-backend.md) |

## Context

Much of Studify's server work is long-running or asynchronous:
- PDF ingestion: download, page count, text and span extraction, page images, slicing.
- Knowledge-map generation.
- Bulk note/card/question generation via the Message Batches API. Batch results can take minutes to hours.
- Podcast audio synthesis (Phase 3).
- Nightly plan recomputation and push notifications.

Supabase Edge Functions are capped at 150 s wall clock on Free and 400 s on paid plans, with 2 s CPU per request and 256 MB memory ([Supabase docs](https://supabase.com/docs/guides/functions/limits), verified 2026-10-26). PDF parsing and page rendering are CPU- and memory-heavy, so they don't fit there.

## Decision

- A separate **Node.js (TypeScript) worker** in `apps/worker`, sharing `packages/shared` and `packages/prompts`.
- **Queue: pg-boss**, in the same Supabase Postgres (dedicated `pgboss` schema). No extra queue infrastructure.
- Edge Functions **enqueue**; the worker **consumes**. User-visible progress is mirrored into `ai_jobs` and broadcast over Realtime.
- Jobs are **idempotent**, with deterministic keys (e.g. one knowledge map per document version), retries with exponential backoff, a dead-letter state surfaced in `ai_jobs.status = failed` with a PT-BR reason, and per-job timeouts.
- Batch jobs are **polled** by a scheduled pg-boss job (`ai.batch.poll`, every 1–2 min while batches are open). Results are matched by `custom_id`, never by position.
- The worker connects to Postgres through a **direct (session) connection** suitable for pg-boss's long-lived connections and `LISTEN/NOTIFY` (not the transaction pooler).

### Hosting: open (decide before Phase 0 ends)

The worker needs a **long-lived process** (a pg-boss poller), ≥ 1 GB RAM for PDF rendering, and secrets storage. The region should be near São Paulo (the database region).

| Candidate | Notes |
|---|---|
| **Fly.io** | Long-lived machines in a region close to São Paulo (`gru`); simple Dockerfile deploy; usage-based pricing. |
| **Railway** | Very simple deploys from the repo; managed secrets; usage-based pricing; check region availability near Brazil. |
| **Render** (background worker) | Background-worker service type fits pg-boss; check region latency to `sa-east-1`. |
| **Google Cloud Run** | Scales to zero, but a pg-boss poller needs `min-instances ≥ 1` (always-on cost) or a different trigger design; São Paulo region available. |
| **AWS (ECS Fargate / Lightsail)** in `sa-east-1` | Same region as Supabase; more setup and IAM work. |
| **Small VPS** | Cheapest; the team manages OS updates, process supervision and secrets. |

Decision criteria: monthly cost at low load, latency to `sa-east-1`, ease of secret management, logs/metrics, and who on the team can operate it.

## Alternatives considered

| Option | Why not |
|---|---|
| **Only Edge Functions** (chained invocations) | Hard limits on wall clock, CPU and memory. PDF rendering and batch polling don't fit. |
| **Supabase Queues (pgmq) + Edge Function consumers** | Queue is fine, but the consumers would still hit Edge Function limits. Reconsider for light jobs. |
| **Redis-based queue (BullMQ)** | Adds a Redis service. pg-boss uses the Postgres we already have. |
| **Managed workflow engines (Temporal, Inngest, Trigger.dev)** | Powerful, but another vendor/system to learn. Overkill at this scale. Revisit if job orchestration grows. |

## Consequences

- **+** No extra queue infrastructure. Jobs are transactional with the data they produce.
- **+** Long PDF processing and asynchronous batch work fit naturally.
- **−** One more deployable to operate and monitor (Sentry + health check + alerts on queue depth and failed jobs).
- **−** A pg-boss poller adds steady connection and query load to Postgres. Tune poll intervals, and use one worker instance with concurrency limits per queue.
- **−** The hosting choice is still open and blocks the Phase 0 exit (production worker).
