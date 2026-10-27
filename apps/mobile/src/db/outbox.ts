// Outbox: pending mutations that must reach the server (mobile-app.md §4.2–4.3).
// Every row has a client UUID v7 that doubles as the server idempotency key.
import { and, asc, count, eq, gt, gte, isNotNull, lt, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Db } from './client';
import { outbox } from './schema';
import { MAX_ATTEMPTS, SYNC_SCHEMA_VERSION } from './sync/constants';

export const OUTBOX_KINDS = [
  'review_log',
  'quiz_attempt',
  'attempt_answer',
  'plan_item_status',
  'card_override',
  'card_state_flag',
  'node_user_setting',
  'subject_user_setting',
  'mistake_update',
  'note_highlight',
  'flag',
  'feed_impression',
  'xp_event',
  'study_session',
  'topic_read',
  'podcast_play',
  'study_preferences',
] as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export type OutboxRow = typeof outbox.$inferSelect;

export interface EnqueueInput {
  kind: OutboxKind;
  payload: unknown;
  /** The entity the mutation edits (last primary-key column). Tombstones drop pending edits by it. */
  entityId?: string | null;
  /** Reuse a client id (e.g. the review log id). Defaults to a new UUID v7. */
  id?: string;
  /** Epoch ms. Defaults to the device clock. */
  createdAt?: number;
}

/** Appends a mutation to the outbox. Pass a transaction handle to make it atomic with a local write. */
export function enqueueOutbox(db: Db, input: EnqueueInput): string {
  const id = input.id ?? uuidv7();
  db.insert(outbox)
    .values({
      id,
      kind: input.kind,
      entityId: input.entityId ?? null,
      payload: input.payload,
      schemaVersion: SYNC_SCHEMA_VERSION,
      createdAt: input.createdAt ?? Date.now(),
      attempts: 0,
      lastError: null,
    })
    .run();
  return id;
}

/** Rows that automatic pushes may still send (not stuck). Keyset-paginated by (created_at, id). */
export function listPushableRows(db: Db, after: { createdAt: number; id: string } | null, limit: number): OutboxRow[] {
  const conditions = [lt(outbox.attempts, MAX_ATTEMPTS)];
  if (after) {
    const keyset = or(
      gt(outbox.createdAt, after.createdAt),
      and(eq(outbox.createdAt, after.createdAt), gt(outbox.id, after.id)),
    );
    if (keyset) conditions.push(keyset);
  }
  return db
    .select()
    .from(outbox)
    .where(and(...conditions))
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .limit(limit)
    .all();
}

export interface OutboxCounts {
  /** Rows waiting to be sent (or retried after backoff). */
  pending: number;
  /** Rows the server rejected MAX_ATTEMPTS times. Kept, surfaced to the user, not retried automatically. */
  stuck: number;
}

export function countOutbox(db: Db): OutboxCounts {
  const pending = db
    .select({ n: count() })
    .from(outbox)
    .where(lt(outbox.attempts, MAX_ATTEMPTS))
    .get();
  const stuck = db.select({ n: count() }).from(outbox).where(gte(outbox.attempts, MAX_ATTEMPTS)).get();
  return { pending: Number(pending?.n ?? 0), stuck: Number(stuck?.n ?? 0) };
}

export function listStuckRows(db: Db): OutboxRow[] {
  return db
    .select()
    .from(outbox)
    .where(and(gte(outbox.attempts, MAX_ATTEMPTS), isNotNull(outbox.id)))
    .orderBy(asc(outbox.createdAt))
    .all();
}

/** User action "tentar de novo": clears the failure count of stuck rows so they are sent again. */
export function retryStuckRows(db: Db): number {
  const result = db
    .update(outbox)
    .set({ attempts: 0, lastError: null })
    .where(gte(outbox.attempts, MAX_ATTEMPTS))
    .run();
  return result.changes;
}

/** Drops every pending mutation for an entity (used when the server tombstones it). */
export function dropOutboxForEntity(db: Db, entityId: string): number {
  return db.delete(outbox).where(eq(outbox.entityId, entityId)).run().changes;
}
