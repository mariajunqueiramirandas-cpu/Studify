# 0010 — Direct SSE operations in one API service

| Status | Accepted |
|---|---|
| Date | 2026-10-28 |
| Supersedes | [0005](0005-job-worker-pg-boss.md) and [0009](0009-no-request-waits-on-claude.md) |

## Context

The owner wants immediate SSE responses and one backend deployment. Queue pickup, job retries, the separate worker service, and client polling add latency and operational complexity to student interactions. SSE must open before retrieval, model thinking, and the first model token, including functions that return structured JSON.

## Decision

Run one Bun/Hono API process. Move the former worker's domain handlers into `packages/server-tasks`, a library invoked directly by the API. Remove pg-boss, its interactive consumer, and the worker container. Generation uses standard model calls; Message Batches support remains a provider/domain test capability, and is disabled in the production runtime.

Clients request `Accept: text/event-stream` and carry a UUIDv7 `Idempotency-Key`. After authentication, input validation and idempotency admission, the API immediately returns an SSE connection comment and `meta`. Conversational handlers emit deltas and citations; structured handlers emit their final JSON as `done.result`. The existing handler status is available as `done.status`. Errors after admission arrive as a terminal `error` with code, message, HTTP-equivalent status and optional budget details. Clients without the SSE accept header retain JSON behavior, with operations invoked directly instead of deferred.

Every data event has a monotonically increasing `id`. The mobile app uses `expo/fetch`, incremental UTF-8 decoding, and `Last-Event-ID` when reconnecting with the same operation key. A reconnect attaches to the live producer immediately. Completed transcripts replay from the idempotency store for 24 hours. Same-key body mismatches fail; concurrent identical structured AI calls by the same student join, and every joined key gets its own durable result. Admission is serialized per student/function; unrelated students and functions remain independent.

A disconnected subscriber does not cancel the shared operation. This preserves paid work across temporary network loss, screen unmounts and app backgrounding. Client cancellation stops observation and reconnect attempts. A 30-minute operation deadline propagates cancellation to model calls; individual model attempts also have deadlines. There is no automatic retry of a whole operation with side effects. Provider retries remain bounded inside a model request.

Direct operations enforce admission limits (two active document ingestions per operation type, one page-render operation, and sixteen per other operation by default). Overflow fails immediately with `rate_limited`; it never waits in an execution queue.

The server sends heartbeat comments every 15 seconds, without storing them in the transcript. It bounds each transcript at 8 MiB and each live subscriber buffer at 512 KiB; slow subscribers disconnect and resume. `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` discourage intermediaries from buffering. Reverse-proxy streaming still needs verification on the deployed host.

Timed work remains necessary when no student has an open app. A small calendar in the API stores only future triggers in `private.scheduled_actions`: notification delivery, battle/duel deadlines, budget resets and UTC cron triggers. Immediate work bypasses it entirely. Calendar triggers survive restarts, fire at most once, and have no job lifecycle, lease, dead-letter machinery or automatic retry. Failures are logged and require manual retry. Long calendar operations do not block the next timer tick. There are at most 16 concurrent calendar operations.

Only one API process may own the runtime. A session advisory lock enforces this. Deploy with one replica and stop-first ordering. On startup the API marks orphaned request placeholders and active progress rows interrupted; documents left processing become retryable failures. Existing ingestion checkpoints and deterministic content keys allow a fresh retry to reuse saved domain state. Completed operations remain replayable. SIGTERM stops accepting connections, drains connected and detached operations, then closes the scheduler and database; Compose allows 60 seconds and the process enforces a 50-second drain deadline.

## Consequences

- Student interactions start without queue pickup or client polling. A stream is active while retrieval and the model are working.
- There is one backend service to deploy and observe. The database remains the source of truth for results, progress, budgets and calendar entries.
- SSE gives progress and transport recovery; it does not make model inference faster or provide durable execution across process crashes.
- API crashes can interrupt active operations. Unclaimed calendar entries survive; a calendar action interrupted after claim may be lost. No blanket retries conceal that distinction or repeat paid side effects.
- PDF processing shares the API's resources. Monitor event-loop delay, memory, stream latency and task concurrency on real PDFs before increasing load.
- Horizontal scaling requires a shared live-stream transport or explicit request affinity and a different ownership/recovery design. It is outside this decision.

## Rollout

Apply `20261028040000_direct_sse_operations.sql` first. Drain or explicitly resolve the old pg-boss backlog before removing the old services; the new runtime does not consume old queues or adopt outstanding provider batches. Stop the old worker and API, deploy the new single API service, then ship the updated mobile app. Leave historical pg-boss tables in place for inspection; this change does not drop them. Remove obsolete `PG_BOSS_SCHEMA`, `AI_USE_BATCH` and `WORKER_LOG_LEVEL` settings (`TASK_LOG_LEVEL` replaces the latter).
