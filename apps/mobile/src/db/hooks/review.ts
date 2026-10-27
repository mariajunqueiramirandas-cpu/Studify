// Review write path (mobile-app.md §6, ADR 0004, ADR 0007). The single code path used by the review
// screen, the home-screen widget and notification actions:
//   1. schedule with ts-fsrs on device (immediately, offline),
//   2. write the local card_state and a local review_logs row,
//   3. append a `review_log` outbox row (client UUID = idempotency key),
//   4. refresh queue_cache (read by the widget) and wake the sync controller.
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { createEmptyCard, fsrs, State, type Card, type FSRS, type Grade } from 'ts-fsrs';
import { uuidv7 } from 'uuidv7';
import type { AppDb, Db } from '../client';
import { enqueueOutbox } from '../outbox';
import { cards, cardStates, profiles, queueCache, reviewLogs } from '../schema';
import { notifyLocalWrite } from '../sync/bus';

export type ReviewSource = 'session' | 'feed' | 'widget' | 'notification' | 'map' | 'vespera';

export interface RecordReviewInput {
  cardId: string;
  /** 1 Errei, 2 Difícil, 3 Bom, 4 Fácil. Widget and notifications use 1 and 3. */
  rating: Grade;
  durationMs?: number;
  source?: ReviewSource;
  hintUsed?: boolean;
  /** Override the clock (tests). */
  now?: Date;
}

export interface RecordReviewResult {
  logId: string;
  cardId: string;
  /** Next due instant. */
  due: Date;
  /** Interval in days until the next review (0 for learning steps). */
  intervalDays: number;
  state: State;
}

export class ReviewError extends Error {
  readonly code: 'no_profile' | 'card_not_found' | 'review_not_found' | 'already_undone';

  constructor(code: ReviewError['code'], message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

const QUEUE_SIZE = 100;

type CardStateRow = typeof cardStates.$inferSelect;

/** Local profile id (the signed-in user). The profile is pulled right after sign-in. */
export function currentUserId(db: Db): string {
  const row = db.select({ id: profiles.id }).from(profiles).where(isNull(profiles.deletedAt)).limit(1).get();
  if (!row) throw new ReviewError('no_profile', 'Nenhum perfil local: entre na conta antes de revisar.');
  return row.id;
}

// ---------- scheduler ----------

const schedulerCache = new Map<string, FSRS>();

/** ts-fsrs instance from `profiles.settings.memory` (desired retention, optimized parameters). */
export function schedulerFor(settings: unknown): FSRS {
  const memory = (settings as { memory?: { desired_retention?: unknown; fsrs_params?: unknown } } | null)?.memory ?? {};
  const retention = typeof memory.desired_retention === 'number' ? memory.desired_retention : 0.9;
  const params =
    Array.isArray(memory.fsrs_params) && memory.fsrs_params.length >= 17 ? (memory.fsrs_params as number[]) : undefined;
  const key = `${retention}|${params ? params.join(',') : ''}`;
  let scheduler = schedulerCache.get(key);
  if (!scheduler) {
    scheduler = fsrs(params ? { request_retention: retention, w: params } : { request_retention: retention });
    schedulerCache.set(key, scheduler);
  }
  return scheduler;
}

function schedulerForUser(db: Db, userId: string): FSRS {
  const row = db.select({ settings: profiles.settings }).from(profiles).where(eq(profiles.id, userId)).get();
  return schedulerFor(row?.settings);
}

function toFsrsCard(row: CardStateRow): Card {
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsedDays,
    scheduled_days: row.scheduledDays,
    learning_steps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.lastReview ?? undefined,
  };
}

function snapshotOf(row: CardStateRow): Record<string, unknown> {
  return {
    subjectId: row.subjectId,
    due: row.due.getTime(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    learningSteps: row.learningSteps,
    lastReview: row.lastReview ? row.lastReview.getTime() : null,
    suspended: row.suspended,
    hidden: row.hidden,
    isLeech: row.isLeech,
    introducedAt: row.introducedAt ? row.introducedAt.getTime() : null,
    lastLogId: row.lastLogId,
    pulledAt: row.pulledAt ? row.pulledAt.getTime() : null,
  };
}

function rowFromSnapshot(userId: string, cardId: string, snap: Record<string, unknown>, updatedAt: Date): CardStateRow {
  const ms = (v: unknown) => (typeof v === 'number' ? new Date(v) : null);
  return {
    userId,
    cardId,
    subjectId: String(snap['subjectId']),
    due: new Date(Number(snap['due'])),
    stability: Number(snap['stability']),
    difficulty: Number(snap['difficulty']),
    elapsedDays: Number(snap['elapsedDays']),
    scheduledDays: Number(snap['scheduledDays']),
    reps: Number(snap['reps']),
    lapses: Number(snap['lapses']),
    state: Number(snap['state']),
    learningSteps: Number(snap['learningSteps']),
    lastReview: ms(snap['lastReview']),
    suspended: Boolean(snap['suspended']),
    hidden: Boolean(snap['hidden']),
    isLeech: Boolean(snap['isLeech']),
    introducedAt: ms(snap['introducedAt']),
    lastLogId: (snap['lastLogId'] as string | null) ?? null,
    updatedAt,
    pulledAt: ms(snap['pulledAt']),
  };
}

/** Rebuilds `queue_cache` (the widget's queue): the next due cards for the user, earliest first. */
export function refreshQueueCache(db: Db, userId: string, now: Date): void {
  const due = db
    .select({ cardId: cardStates.cardId, due: cardStates.due })
    .from(cardStates)
    .where(
      and(
        eq(cardStates.userId, userId),
        lte(cardStates.due, now),
        eq(cardStates.suspended, false),
        eq(cardStates.hidden, false),
      ),
    )
    .orderBy(asc(cardStates.due))
    .limit(QUEUE_SIZE)
    .all();
  db.delete(queueCache).run();
  if (due.length > 0) {
    db.insert(queueCache)
      .values(due.map((r) => ({ cardId: r.cardId, effectiveDue: r.due.getTime(), priority: 0, boostExamId: null })))
      .run();
  }
}

// ---------- public API ----------

/**
 * Records one review. Works offline: scheduling is local and the server replays the log later.
 * Safe to call from the widget or a notification action (pass the database from `ensureAppDatabase`).
 */
export async function recordReview(db: AppDb, input: RecordReviewInput): Promise<RecordReviewResult> {
  const userId = currentUserId(db);
  const card = db.select({ subjectId: cards.subjectId }).from(cards).where(eq(cards.id, input.cardId)).get();
  const existing = db
    .select()
    .from(cardStates)
    .where(and(eq(cardStates.userId, userId), eq(cardStates.cardId, input.cardId)))
    .get();
  const subjectId = existing?.subjectId ?? card?.subjectId;
  if (!subjectId) throw new ReviewError('card_not_found', 'Cartão não encontrado.');

  const now = input.now ?? new Date();
  const scheduler = schedulerForUser(db, userId);
  const before = existing ? toFsrsCard(existing) : createEmptyCard(now);
  const { card: next, log } = scheduler.next(before, now, input.rating);
  const logId = uuidv7();
  const source = input.source ?? 'session';
  const hintUsed = input.hintUsed ?? false;
  const durationMs = input.durationMs ?? null;

  db.transaction((tx) => {
    const row: CardStateRow = {
      userId,
      cardId: input.cardId,
      subjectId,
      due: next.due,
      stability: next.stability,
      difficulty: next.difficulty,
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      reps: next.reps,
      lapses: next.lapses,
      state: next.state,
      learningSteps: next.learning_steps,
      lastReview: next.last_review ?? now,
      suspended: existing?.suspended ?? false,
      hidden: existing?.hidden ?? false,
      isLeech: existing?.isLeech ?? false,
      introducedAt: existing?.introducedAt ?? (next.state !== State.New ? now : null),
      lastLogId: logId,
      updatedAt: now,
      pulledAt: existing?.pulledAt ?? null,
    };
    tx.insert(cardStates)
      .values(row)
      .onConflictDoUpdate({ target: [cardStates.userId, cardStates.cardId], set: row })
      .run();

    tx.insert(reviewLogs)
      .values({
        id: logId,
        userId,
        cardId: input.cardId,
        rating: input.rating,
        reviewedAt: now,
        clientReviewedAt: now,
        elapsedDays: log.elapsed_days,
        scheduledDays: log.scheduled_days,
        stateBefore: before.state,
        durationMs,
        source,
        reason: 'scheduled',
        hintUsed,
        undoesLogId: null,
        deviceId: null,
        clockSkew: false,
        prevCardState: existing ? snapshotOf(existing) : null,
        createdAt: now,
      })
      .run();

    enqueueOutbox(tx, {
      kind: 'review_log',
      id: logId,
      entityId: input.cardId,
      createdAt: now.getTime(),
      payload: {
        id: logId,
        card_id: input.cardId,
        rating: input.rating,
        reviewed_at: now.toISOString(),
        client_reviewed_at: now.toISOString(),
        elapsed_days: log.elapsed_days,
        scheduled_days: log.scheduled_days,
        state_before: before.state,
        duration_ms: durationMs,
        source,
        reason: 'scheduled',
        hint_used: hintUsed,
      },
    });

    refreshQueueCache(tx, userId, now);
  });

  notifyLocalWrite('local_write');
  return {
    logId,
    cardId: input.cardId,
    due: next.due,
    intervalDays: next.scheduled_days,
    state: next.state,
  };
}

/**
 * Undoes a review recorded on this device: restores the card state from the local snapshot and
 * appends a compensating `review_log` (`undoes_log_id`), which the server replay cancels out.
 */
export async function undoReview(db: AppDb, logId: string): Promise<void> {
  const original = db.select().from(reviewLogs).where(eq(reviewLogs.id, logId)).get();
  // Undo rows are compensations, not reviews: they cannot be undone themselves.
  if (!original || original.undoesLogId) throw new ReviewError('review_not_found', 'Revisão não encontrada.');
  const alreadyUndone = db
    .select({ id: reviewLogs.id })
    .from(reviewLogs)
    .where(eq(reviewLogs.undoesLogId, logId))
    .get();
  if (alreadyUndone) throw new ReviewError('already_undone', 'Essa revisão já foi desfeita.');

  const userId = original.userId;
  const now = new Date();
  const undoId = uuidv7();

  db.transaction((tx) => {
    const restored: CardStateRow = original.prevCardState
      ? rowFromSnapshot(userId, original.cardId, original.prevCardState, now)
      : rowFromEmpty(tx, userId, original.cardId, now);
    tx.insert(cardStates)
      .values(restored)
      .onConflictDoUpdate({ target: [cardStates.userId, cardStates.cardId], set: restored })
      .run();

    tx.insert(reviewLogs)
      .values({
        id: undoId,
        userId,
        cardId: original.cardId,
        rating: original.rating,
        reviewedAt: now,
        clientReviewedAt: now,
        elapsedDays: null,
        scheduledDays: null,
        stateBefore: null,
        durationMs: null,
        source: original.source,
        reason: 'scheduled',
        hintUsed: false,
        undoesLogId: logId,
        deviceId: null,
        clockSkew: false,
        prevCardState: null,
        createdAt: now,
      })
      .run();

    enqueueOutbox(tx, {
      kind: 'review_log',
      id: undoId,
      entityId: original.cardId,
      createdAt: now.getTime(),
      payload: {
        id: undoId,
        card_id: original.cardId,
        rating: original.rating,
        reviewed_at: now.toISOString(),
        client_reviewed_at: now.toISOString(),
        undoes_log_id: logId,
        source: original.source,
        reason: 'scheduled',
        hint_used: false,
      },
    });

    refreshQueueCache(tx, userId, now);
  });

  notifyLocalWrite('local_write');
}

function rowFromEmpty(db: Db, userId: string, cardId: string, now: Date): CardStateRow {
  const empty = createEmptyCard(now);
  const subject = db.select({ subjectId: cards.subjectId }).from(cards).where(eq(cards.id, cardId)).get();
  return {
    userId,
    cardId,
    subjectId: subject?.subjectId ?? '',
    due: empty.due,
    stability: empty.stability,
    difficulty: empty.difficulty,
    elapsedDays: empty.elapsed_days,
    scheduledDays: empty.scheduled_days,
    reps: empty.reps,
    lapses: empty.lapses,
    state: empty.state,
    learningSteps: empty.learning_steps,
    lastReview: null,
    suspended: false,
    hidden: false,
    isLeech: false,
    introducedAt: null,
    lastLogId: null,
    updatedAt: now,
    pulledAt: null,
  };
}
