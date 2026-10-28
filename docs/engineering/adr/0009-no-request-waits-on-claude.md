# 0009 — No request waits on Claude: AI work runs as a job or a resumable stream

| Status | Proposed |
|---|---|
| Date | 2026-10-28 |
| Related | [0005 — Job worker with pg-boss](0005-job-worker-pg-boss.md) · [0008 — VPS, Bun and Hono](0008-vps-bun-hono-api.md) · [AI pipeline](../ai-pipeline.md) · [API](../api.md) |

## Context

Students report buttons that seem to do nothing and then fail with a generic error. The code and the production logs of 2026-10-28 show why.

**1. Twenty endpoints wait on Claude inside a plain JSON request.** Sixteen call `callTask` directly: `argument-finish`, `argument-themes`, `capture-act`, `capture-analyze`, `card-draft`, `cards-generate-more`, `divide-review`, `essay-theme-generate`, `grade-answer`, `grade-essay`, `mnemonic-suggest`, `peer-question-create`, `problem-check-work`, `scope-resolve`, `teaching-start` and `visual-generate`. Four reach it through shared helpers: `trail-prepare` (`generate` in `shared/trail.ts`), `trail-open` (`planChapters`, same file), and `questions-generate-more` and `quiz-create` (`generateQuestionsForNode` in `shared/questions.ts`). All of them hold the HTTP request open until Claude answers. The logs show `trail-prepare` at 38.8 s, `visual-generate` at 24.3 s, `teaching-start` at 21.6 s, `trail-open` at 5.6 s, and `mnemonic-suggest` failing with a 503 after 11.5 s.

**2. The deadline chain is inverted.** Each layer allows longer than the layer outside it:

| Layer | Limit today |
|---|---|
| Mobile `callFunction` (`apps/mobile/src/api/functions.ts`) | none |
| Bun `idleTimeout` (`apps/api/src/server.ts`) | 255 s |
| Claude call (`apps/api/src/shared/prod.ts`) | 120 s per attempt × 3 attempts (SDK `maxRetries: 2`) ≈ 360 s + backoff |

The innermost layer can outlive the server socket. The client has no limit at all, so the request ends whenever the mobile network or an intermediary gives up, and that surfaces as `offline` or as the generic message. Any proxy in front of `studify.vendua.com.br` is configured outside this repository and adds an unknown limit of its own.

**3. A disconnect does not stop the work.** The server never passes a cancellation signal to `callTask`. After the client gives up, the handler keeps running, spends budget and stores its response under an `Idempotency-Key` the client has already discarded.

**4. A second attempt is treated as an error.** With no progress feedback, students tap again. `visual/[nodeId].tsx` also starts `generateVisual` from a mount effect, so a remount fires a second request. Each attempt gets a fresh key, and the second request collides with the first. The logs show `visual-generate` returning 409 at 19:14:50 while the first request was still running (it finished at 19:14:58 with 201), and `teaching-start` returning 409 at 19:15:19, about 13 s into a request that finished at 19:15:28 with 200.

**5. Stream recovery fails in the same way.** `streamFunction` retries a dropped stream once with the same key. If the server handler is still running, `beginIdempotent` returns `in_flight`, and `shared/http.ts` turns that into `409 already_exists` ("Esse pedido já está sendo feito"). The retry meant to recover the stream ends in an error.

**6. Screens hide the cause.** Many handlers catch every error and show `error.generic` or `error.generation`, so a timeout, a duplicate, a budget limit and a real failure all look the same.

Raising timeouts or adding a client timeout alone would move the failure, not remove it. The problem is structural: a mobile client holds a socket open for work that takes tens of seconds and that the socket does not own.

## Decision

### Rule 1 — No plain HTTP request waits on Claude

Every AI call takes one of two shapes.

**Stream.** For conversational turns where the student reads text as it arrives: `tutor-chat`, `explain`, `argument-turn`, `teaching-turn`, `note-generate`, `podcast-ask`, and the explain and solve paths of `capture-act`. These stay SSE with the existing 15 s heartbeat (`shared/sse.ts`), and gain resumption (Rule 3).

**Job.** Everything else. The endpoint validates the input, checks access and budget, enqueues a pg-boss job backed by an `ai_jobs` row, and returns **`202 { job_id, status }` within one second**. The worker runs the Claude call, writes the output to its domain table, and moves the job to `succeeded` or `failed`. The client follows the job with `useJob` (Realtime on `ai_jobs`, with the existing fetch as a fallback) and reads the result from the domain row. `vespera-prepare` already uses this contract. ADR 0005 already provides the worker, the queue and the job table.

- `ai_jobs` gains `result_ref jsonb` (for example `{ "table": "visuals", "id": "…" }`), a pointer to the domain row that holds the output. Results stay in domain tables under their row-level security, not in the job row.
- Interactive jobs run on their own queue, with higher priority and concurrency than ingestion and Batch waves, so a student's tap does not wait behind a document import.
- **Enforcement:** a test in `apps/api` fails if anything under `apps/api/src` calls `callTask` or `callClaude`. It covers the whole source tree, not only `src/functions/`, because handlers also reach Claude through shared helpers (`trail-prepare` through `shared/trail.ts`). Streams use `openStream`, and everything else enqueues. There is no allowlist. Once it passes, non-streaming Claude calls exist only in the worker.

### Rule 2 — A repeated intent joins the running work, it is never an error

- Every job is enqueued with a `singletonKey` that names the resource and the intent, for example `visual:<node_id>:<type>` or `teaching:<user_id>:<node_id>`. A second submit while the first is queued or running returns **202 with the existing `job_id`**. `trail-prepare` already behaves this way through its per-trail lease, where a concurrent call returns the current state; this rule makes it the default for every endpoint.
- The idempotency layer changes the same way for every function: `in_flight` returns **`202 { status: "running" }` with a `Retry-After` header** instead of `409 already_exists`. A retry with the same key is a status check, not a conflict.

### Rule 3 — Deadlines are explicit, and each layer is shorter than the one outside it

| Layer | Deadline | On expiry |
|---|---|---|
| Client, job submit and any non-AI JSON call | 20 s | `ApiError('timeout')`, a specific message, and the action stays retryable with the same key |
| Client, waiting for a job to finish | no hard limit; after 30 s the screen says "está demorando mais que o normal" and keeps following the job | the job's own state decides the outcome |
| Worker, one interactive job | 180 s total; SDK `timeout` 60 s per attempt, SDK `maxRetries` 1; further retries belong to pg-boss (`retryLimit`) | job `failed` with an `error_message_key` |
| Client, stream stall | 45 s with no bytes (three missed heartbeats) | abort, then resume with the same key |
| Server, one stream | 180 s total, below Bun's 255 s `idleTimeout` | final `error` event |
| Proxy in front of the API (outside the repo) | must allow at least 255 s idle for SSE | to be verified on the host |

**Stream resumption:** after a drop, the client reconnects with the same `Idempotency-Key`. While the original handler is still running, it gets `202 running` and retries after `Retry-After`. Once the handler has finished, it gets the stored result: SSE handlers must store a replayable final payload (the message and its `done` event) through `handle.complete`.

### Rule 4 — Errors say what happened

- The mobile client adds two codes: `timeout` (a client deadline passed) and `running` (the work is still in progress, which is not an error). `offline` stays for "no response at all".
- Screens show errors through one shared helper, `messageFor(error)`, which maps every known `ApiError` code to its copy. `error.generic` is only for codes the helper does not know. Catch-alls that ignore the code (`.catch(() => overlay.snack(t('error.generic')))`) are removed.

### Migration

| Phase | Scope | Effect |
|---|---|---|
| 0 | Client deadlines and the `timeout` code; idempotency `in_flight` → `202 running`; stream stall detection and resume loop; mount guard in `visual/[nodeId].tsx`; SDK `maxRetries` 1 in the API | Ends the silent hang and the 409-as-error immediately, before any endpoint moves |
| 1 | Move the slowest synchronous endpoints to jobs: `trail-prepare`, `visual-generate`, `teaching-start`, `grade-essay`, `capture-analyze`, `mnemonic-suggest` | Removes the long waits students hit today |
| 2 | Move the rest of the synchronous AI endpoints listed in Context, then turn on the enforcement test | The rule holds for every endpoint and stays enforced |
| 3 | Replace catch-all error handlers with `messageFor` | Failures name their cause |

Track the request log's `ms` per path and the `ai_usage` latency rows to confirm each phase: no AI-backed JSON request should exceed one second at p95 after Phase 2.

## Alternatives considered

- **Only add a client timeout.** The hang becomes a faster error, but the work keeps running and spending, and a retry still collides with it. This is kept as one layer of Phase 0, not as the fix.
- **Raise every timeout.** Mobile networks and intermediaries drop long idle sockets whatever the server allows, and duplicates still collide.
- **Stream every AI call.** A socket stays open for results nobody reads token by token, backgrounding the app still kills it, and nothing survives an app restart. Jobs survive both.
- **Wait inline for a few seconds, then fall back to 202.** This gives two code paths per endpoint and runs the work inside the API process, where a deploy loses it. A single job path is simpler to test, and its work is durable.

## Consequences

- No AI-backed JSON request holds a socket for more than about a second, and no stream stays silent for more than 15 s.
- Double taps, remounts and reconnects join the running work instead of failing.
- Results survive the app going to the background, the network dropping and API deploys. pg-boss retries failed work, and its spend is recorded against a job the student can still see.
- Short tasks gain the worker's pickup latency (pg-boss polling interval). The interactive queue polls at its minimum interval to keep this under about a second.
- Twenty endpoints move: each needs a worker handler, a `result_ref` target and a screen change to `useJob`. Phase 1 covers the six slowest.
- Worker capacity becomes interactive capacity. Its hosting, still open in ADR 0005, must be sized for the interactive queue.
- Completion relies on Realtime, with polling as the fallback `useJob` already has.

### Open questions

- The idle timeout of whatever proxies `studify.vendua.com.br`. It must be checked on the host, since it is not in the repository.
- Which domain table holds each moved endpoint's result. Some have one already, such as visuals and teaching sessions; others may need one.
