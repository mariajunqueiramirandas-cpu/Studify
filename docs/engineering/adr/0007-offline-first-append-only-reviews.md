# 0007 — Offline-first with append-only review logs

| Status | Accepted |
|---|---|
| Date | 2026-10-26 |
| Related | [Architecture §4.2](../architecture.md#42-review-offline-first-mem-02) · [Mobile app §4](../mobile-app.md#4-offline-first-design) · [ADR 0004](0004-fsrs-on-device.md) · [Testing §5.3](../testing-strategy.md#53-offline-sync-plt-07-adr-0007) |

## Context

- Students review on phones with unreliable connectivity. The same student may review on a phone, through the widget or notification actions, and later perhaps on a second device.
- Losing or double-counting reviews corrupts the FSRS schedule, mastery, Mapa da Memória and plan progress, which is the core value of the app (PLT-07, MEM-02).
- Card state is a pure function of the card's review history under FSRS, so the history itself can be the source of truth.

## Decision

1. **Reviews are events.** Each rating is appended to `review_logs` with a **client-generated UUID v7**, `reviewed_at` (device time), rating, elapsed time and device id. The log is **append-only**: no client UPDATE or DELETE (enforced by RLS).
2. **Local first.** The device schedules immediately with `ts-fsrs`, updates its local `card_state` and writes the log to an **outbox** in SQLite. The UI never waits for the network.
3. **Idempotent push.** The outbox is pushed in batches. The server inserts with `ON CONFLICT (id) DO NOTHING`, so retries and replays are harmless.
4. **Server derives state.** For each affected (user, card), the server **replays all logs in `reviewed_at` order** with the same FSRS version and writes the authoritative `card_states`. It returns them in the ack, and the device overwrites its prediction.
5. **Concurrent devices converge.** Reviews of the same card on two offline devices are both kept. Replay order makes the result deterministic regardless of sync order.
6. **Clock sanity.** Logs with `reviewed_at` more than 5 min in the future (relative to server receipt) are stored but flagged `clock_skew` and replayed at receipt time instead.
7. **Other offline mutations** (plan item status, card overrides, mistake causes, flags) use the same outbox with **last-writer-wins** on `updated_at` (clamped to server time ± 5 min). **Deletes (tombstones) win** over edits.
8. **Pull** is incremental per table by `(updated_at, id)` cursor, after push.

## Alternatives considered

| Option | Why not |
|---|---|
| **Sync mutable `card_states` with last-writer-wins** | Two devices reviewing offline would lose one review. FSRS state can't be "merged" without the history. |
| **Online-only reviews** | Breaks the core use case (bus, school without Wi-Fi, widget). |
| **CRDT / sync framework** (e.g. PowerSync, ElectricSQL, WatermelonDB sync) | Capable, but more machinery and vendor coupling than needed for one append-only stream plus a few LWW fields. Revisit if offline scope grows a lot (e.g. offline quiz authoring). |

## Consequences

- **+** No review is ever lost or double-counted. Full history enables later FSRS parameter optimization per user, analytics and audits.
- **+** Simple server logic: insert-if-absent, then deterministic replay.
- **−** `review_logs` grows without bound. Index on `(user_id, card_id, reviewed_at)`. Replay cost is small per card, but a periodic snapshot (state + last log id) can bound it.
- **−** Device and server state can differ until sync. The UI treats server state as authoritative after ack.
- **−** Requires disciplined testing of multi-device and replay scenarios ([testing-strategy.md §5.3](../testing-strategy.md#53-offline-sync-plt-07-adr-0007)).
