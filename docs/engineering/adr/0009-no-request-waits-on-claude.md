# 0009 — No request waits on Claude: AI work runs as a job or inside a stream

| Status | Superseded by [0010 — Direct SSE API](0010-direct-sse-api.md) |
|---|---|
| Date | 2026-10-28 |
| Related | [0005 — Job worker with pg-boss](0005-job-worker-pg-boss.md) · [0008 — VPS, Bun and Hono](0008-vps-bun-hono-api.md) · [AI pipeline](../ai-pipeline.md) · [API](../api.md) |

## Context

Students report buttons that seem to do nothing and then fail with a generic error. The code and the production logs of 2026-10-28 show why.

**1. Twenty-five functions wait on Claude while the student's request is open.** Twenty-three make a plain Claude call (`callTask`) inside a JSON request. Seventeen call it directly: `argument-finish`, `argument-start` (moderation of a custom theme), `argument-themes`, `capture-act` (the hint ladder), `capture-analyze`, `card-draft`, `cards-generate-more`, `divide-review`, `essay-theme-generate`, `grade-answer`, `grade-essay`, `mnemonic-suggest`, `peer-question-create`, `problem-check-work`, `scope-resolve`, `teaching-start` and `visual-generate`. Six reach it through shared helpers: `trail-prepare` and `trail-open` (`shared/trail.ts`), `questions-generate-more` and `quiz-create` (`shared/questions.ts`), `teaching-finish` (`shared-p3/lucas.ts`) and `divide-submit` (`shared-p4/moderation.ts`). Two streaming functions, `teaching-turn` and `argument-turn`, made their Claude call before opening the stream, and so did `capture-act` when the solution was asked for before any hint. The logs show `trail-prepare` at 38.8 s, `visual-generate` at 24.3 s, `teaching-start` at 21.6 s, `trail-open` at 5.6 s, and `mnemonic-suggest` failing with a 503 after 11.5 s.

**2. The deadline chain is inverted.** Each layer allows longer than the layer outside it:

| Layer | Limit before this ADR |
|---|---|
| Mobile `callFunction` (`apps/mobile/src/api/functions.ts`) | none |
| Bun `idleTimeout` (`apps/api/src/server.ts`) | 255 s |
| Claude call (`apps/api/src/shared/prod.ts`) | 120 s per attempt × 3 attempts (SDK `maxRetries: 2`) ≈ 360 s + backoff |

The innermost layer can outlive the server socket. The client has no limit at all, so the request ends whenever the mobile network or an intermediary gives up, and that surfaces as `offline` or as the generic message. Any proxy in front of `studify.vendua.com.br` is configured outside this repository and adds an unknown limit of its own.

**3. A disconnect does not stop the work.** After the client gives up, the handler keeps running, spends budget and stores its response under an `Idempotency-Key` the client has already discarded.

**4. A repeated request is treated as an error.** The logs show `visual-generate` returning 409 in 481 ms at 19:14:50, 16.5 s into a request that finished at 19:14:58 with 201, and `teaching-start` returning 409 in 427 ms at 19:15:19, 13 s into a request that finished at 19:15:28 with 200. A 409 that fast can only come from the idempotency check (`in_flight`), so the same `Idempotency-Key` arrived twice: the request was re-sent byte for byte, not tapped again (a new tap carries a new key and would run the whole call). The app sends each call once (`callFunction` re-sent only after a 401), so the re-send happened below it. The most likely source is the Android HTTP client (OkHttp, under React Native's `fetch`), which retries a POST when the connection drops during the silent wait; a proxy between the phone and the API is the other candidate. Either way the app received the 409 while the original request completed into a closed connection. Real second taps collide differently: `visual/[nodeId].tsx` starts `generateVisual` from a mount effect, so a remount sends a second request with a fresh key that runs a second paid call.

**5. Stream recovery fails.** `streamFunction` retried a dropped stream once with the same key, and got the same 409 while the handler still ran. Worse, when the client disconnected, the next write to the closed stream threw, the producer failed, and its error handler threw again before the stream could settle: the turn was neither stored nor released for 10 minutes, so no reconnect could ever get the answer.

**6. Screens hide the cause.** Many handlers catch every error and show `error.generic` or `error.generation`. A stream that ended with an `error` event (a budget limit, an AI failure) reached the screen as `offline`.

Raising timeouts or adding a client timeout alone would move the failure, not remove it. The problem is structural: a mobile client holds a socket open for work that takes tens of seconds and that the socket does not own.

## Decision

### Rule 1 — No request waits on Claude in silence

Every Claude call happens in one of two places.

**Inside a stream.** Conversational turns stay SSE with the 15 s heartbeat (`shared/sse.ts`): `tutor-chat`, `explain`, `note-generate`, `podcast-ask`, `teaching-turn`, `argument-turn` and the `explain` and `solution` paths of `capture-act`. A stream opens before any plain Claude call it makes, so the heartbeat covers the wait. `teaching-turn` and `argument-turn` now send `meta`, then call Claude; `capture-act` builds a missing hint ladder inside the solution stream. Their errors arrive as the stream's `error` event.

**As a deferred call.** Everything else runs as a job. A function declares `deferred: true`, or a predicate for functions where only some inputs need it (`capture-act` `solve` hints, `argument-start` with a custom theme). In production the request checks the user, validates the input, takes its `Idempotency-Key` (required for deferred calls, mutating or not), puts the call on the `api.interactive` pg-boss queue and answers **`202` with `x-operation-status: running`, `Retry-After: 1` and `{ status: "running", operation_key }`** in milliseconds. The API process works that queue itself (`serveInteractive` in `shared/prod.ts`, `runDeferred` in `shared/http.ts`): it has the handlers and their dependencies, so they run unchanged, detached from the request. The handler's response, success or failure, is stored under the call's key, where the app's next repeat finds it as a replay.

- The queue is durable: a job whose process dies is retried after 240 s (`retryLimit: 1`). A server error is rethrown for that retry while one is left; the last attempt stores it, so the app stops waiting and shows it. A client error is stored at once. Each tap uses a new key, so a stored failure never blocks a new attempt.
- The queue uses LISTEN/NOTIFY (`useListenNotify`, `notify: true`) so a job starts as soon as it is queued, with 0.5 s polling as the floor, and runs 16 calls at once per API process.
- The worker app (ADR 0005) is unchanged. Moving these handlers into it would have meant rewriting them against its framework; the API process already holds them and a pg-boss connection.
- Without a queue (`deps.defer` unset, as in tests and local tools) a deferred handler runs inline, as before.
- **App builds that predate this ADR keep the old contract.** They would read `202 running` as the final answer, so the server defers, joins and answers `202 running` only for requests with `x-studify-operations: 1`, which new builds send on every call. Older builds get inline calls and `409` for a repeat that is still running, exactly as before.

**Enforcement.** `apps/api/test/no-sync-claude.test.ts` walks the relative imports of `apps/api/src` and fails when a function that can reach a `callTask` or `callClaude` call site does not declare `deferred` or `claudeInsideStream`, when a function declares one without reaching Claude, or when `claudeInsideStream` is declared without a stream. It works at module level, so the Claude-calling trail helpers moved to `shared/trail-generate.ts`, which keeps `trail-answer` (which never calls Claude) out of it.

### Rule 2 — A repeated call joins the running work, it is never an error

- A repeat with the same key while the call runs answers `202 running` instead of `409 already_exists`, for every mutating function and every stream: it is a status check.
- A deferred call identical to one the same student already has running (same function, same body) joins it: the answer is `202 running` with the running call's `operation_key`, and the app follows that key. A remount or a double tap no longer pays twice. Once the first call finishes, the same body is a new call.
- A stream whose client disconnects keeps running into its transcript (`SseWriter.detach`), which is stored under its key; the reconnect gets `202 running` until then, and the whole stream as a replay after.

### Rule 3 — Deadlines are explicit, and each layer is shorter than the one outside it

| Layer | Deadline | On expiry |
|---|---|---|
| App, one HTTP attempt (`REQUEST_DEADLINE_MS`) | 30 s | repeated with the same key, with backoff; three silent attempts in a row → `timeout` |
| App, one operation (`OPERATION_DEADLINE_MS`) | 4 min, while the server answers `202 running` | `timeout`: "Está demorando mais que o normal. Tenta de novo em instantes." |
| App, stream stall (`STREAM_STALL_MS`) | 45 s without a byte (three missed heartbeats) | reconnect with the same key; three in a row → `timeout` |
| Claude, one call | 120 s per attempt × 2 attempts (SDK `maxRetries: 1`) | the handler's error |
| Interactive job | expires after 240 s; one queue retry | stored failure |
| Bun socket idle | 255 s | streams send a heartbeat every 15 s; JSON answers take milliseconds |
| Proxy in front of the API (outside the repo) | must allow at least 255 s idle for SSE | to be verified on the host |

The app's client (`apps/mobile/src/api/operation.ts`, used by `callFunction` and `streamFunction`) repeats a call with the same key after a network failure too: the key makes that safe.

### Rule 4 — Errors say what happened

- The app has a `timeout` code; `offline` stays for "no answer at all"; a `202 running` is never an error.
- A stream's `error` event rejects with that ApiError (code and message) instead of `offline`.
- Screens show failures through `messageFor(error, fallback?)` (`apps/mobile/src/api/messages.ts`): the ApiError's message, written in PT-BR for the student by the server or the client, and the generic copy (or the screen's own fallback) only for anything else. Catch-alls that ignored the error now pass it. The sign-in and onboarding screens keep their deliberately generic answers.

### Observability

The request log adds, for function calls, a 12-character hash of the `Idempotency-Key`, the user agent and `operation: "running"` on running answers, and logs `client disconnected` with the elapsed time when a client leaves before its answer. Each deferred call logs `deferred call` with its function, status and duration. Together they tell a resend by the app's HTTP stack from one by a proxy (Context §4).

## Alternatives considered

- **Only add a client timeout.** The hang becomes a faster error, but the work keeps running and spending, and a retry still collides with it. Kept as one layer, not as the fix.
- **Raise every timeout.** Mobile networks and intermediaries drop long idle sockets whatever the server allows, and duplicates still collide.
- **Stream every AI call.** A socket stays open for results nobody reads token by token, backgrounding the app still kills it, and nothing survives an app restart.
- **Run deferred calls in the worker app.** Durable as well, but every handler and its helpers would be rewritten against the worker's framework. The API process already has both.
- **Report completion through `ai_jobs` and Realtime.** It needs a row per call, which counts toward the per-student heavy-job limit, plus a result table per endpoint. Repeating the request with its key reuses the idempotency store, needs no screen change, and survives a lost Realtime connection.

## Consequences

- No JSON request waits on Claude: deferred calls answer in milliseconds, and streams are never silent for more than 15 s.
- Double taps, remounts, resends and reconnects join the running work instead of failing or paying twice.
- A deferred call survives the network dropping, the app going to the background for a while and an API deploy (the queue retries it); its result waits under its key for 24 hours.
- Short deferred calls gain the queue's pickup time (immediate with NOTIFY, at most 0.5 s by polling) and one extra round trip.
- The API process now does the interactive AI work. Its capacity (16 concurrent calls per process) is the interactive capacity; scale API processes to add more.
- Request bodies of deferred calls sit in the pg-boss job table until its retention removes them, in the same database as the rest of the student's data.
- Older app builds get none of the client-side fixes until they update, and one thing changes for them: a budget or AI error in `teaching-turn` or `argument-turn` now arrives as a stream `error` event, which those builds report as offline. Raising `app_versions.blocks_older` once the new build ships moves everyone to the new client.

### Open questions

- The idle timeout of whatever proxies `studify.vendua.com.br`. It must be checked on the host, since it is not in the repository.
- What re-sent the two requests in Context §4. The new request log fields settle it the next time it happens.
