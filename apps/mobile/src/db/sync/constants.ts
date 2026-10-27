// Sync protocol constants (mobile-app.md §4.3, data-model §9.2, api.md §4.1).

/** Payload schema version sent with every push. The server answers 426 when it is unknown/too old. */
export const SYNC_SCHEMA_VERSION = 1;

/** Max outbox rows per `sync-push` request. */
export const PUSH_BATCH_SIZE = 200;

/** Max rows per PostgREST pull page. */
export const PULL_PAGE_SIZE = 500;

/** A row the server rejects this many times is "stuck": kept, surfaced, not retried automatically. */
export const MAX_ATTEMPTS = 10;

/** Exponential backoff for failed syncs: 5 s, 10 s, 20 s, ... capped at 10 min. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 10 * 60_000;

/** While foregrounded the controller syncs every 5 minutes. */
export const PERIODIC_SYNC_MS = 5 * 60_000;

/** LWW timestamps and server-clamped times tolerate this much clock drift (mobile-app.md §4.3 rule 4). */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

/** Plan items are kept for ±7 days around today (mobile-app.md §4.1). */
export const PLAN_WINDOW_DAYS = 7;
