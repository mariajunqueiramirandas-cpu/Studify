# 0004 — FSRS scheduling on device with `ts-fsrs`

| Status | Accepted |
|---|---|
| Date | 2026-10-26 |
| Related | [Learning engine](../learning-engine.md) · [Mobile app](../mobile-app.md) · [ADR 0007](0007-offline-first-append-only-reviews.md) |

## Context

- Spaced repetition (MEM-02) is at the core of the product. Reviews must work **offline**: on the bus, in school with no Wi-Fi, from the home-screen widget.
- Scheduling must be accurate. FSRS (Free Spaced Repetition Scheduler) predicts recall better than SM-2-style schedulers and models retrievability directly. Retrievability is also needed for Mapa da Memória (MEM-05) and mastery.
- The server also needs scheduling: to recompute authoritative card states from logs, to compute due counts for push notifications, and for the planner.

## Decision

- Use **FSRS** via the **`ts-fsrs`** package, wrapped in `packages/shared/fsrs`.
- The **same pinned version** runs on device (Hermes), in Edge Functions (Deno) and in the worker (Node).
- **The device schedules each review locally and immediately.** The server replays logs to produce the authoritative state ([ADR 0007](0007-offline-first-append-only-reviews.md)).
- Defaults:
  - Desired retention **0.90**.
  - Default FSRS parameters at first. Per-user parameter optimization comes later, once a user has enough reviews (threshold and optimizer set in [learning-engine.md](../learning-engine.md); availability of a TypeScript-compatible optimizer to be verified).
  - Four ratings in the app (Errei / Difícil / Bom / Fácil). The widget and notifications use two (Errei → Again, Acertei → Good).
- **Exam awareness** (cards in scope of an upcoming exam are pulled before the exam date) is a layer **on top of** FSRS in the wrapper, specified in [learning-engine.md](../learning-engine.md), and does not modify FSRS itself.

## Alternatives considered

| Option | Why not |
|---|---|
| **SM-2 (Anki classic)** | Simpler, but it predicts recall worse and has no retrievability model for Mapa da Memória. |
| **Server-only scheduling** | Breaks offline reviews and adds latency to every rating. |
| **Custom scheduler** | Reinvents a well-researched algorithm and needs its own validation. |
| **Different FSRS ports per runtime** | Risk of divergence between device prediction and server state. |

## Consequences

- **+** Instant, offline reviews. The widget and notifications reuse the same code.
- **+** Retrievability per card feeds Mapa da Memória, mastery and the planner.
- **−** Version upgrades of `ts-fsrs` must be coordinated across app (OTA), functions and worker. Golden-schedule tests guard against silent changes ([testing-strategy.md §3.1](../testing-strategy.md#31-fsrs-wrapper-mem-02)).
- **−** Device and server can disagree briefly until sync. The server state wins on ack.
