// Durable finalization of quiz attempts (PRA-01.6). submit() records a pending record in MMKV before it
// clears the runner; quiz-submit grades the attempt on the server only once its row has been synced
// (it answers not_found before that). flushPendingQuizSubmits() retries every pending record and
// keeps it until the server has taken it, so an attempt survives app kills and offline periods.
import type { AttemptAnswerInput, QuizSubmitReq } from '@studify/shared';
import { callFunction } from '../../api/functions';
import { ApiError } from '../../api/errors';
import { getKv } from '../../lib/kv';

export const PENDING_SUBMITS_KEY = 'quiz.pending_submits';
/** A record is dropped after this many failed flushes (the server keeps refusing it). */
export const MAX_FLUSH_FAILURES = 20;
/** A record older than this is dropped, whatever the failures. */
export const MAX_PENDING_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PendingQuizSubmit {
  attempt_id: string;
  finished_at: string;
  answers: AttemptAnswerInput[];
  /** Epoch ms when the record was queued. */
  queued_at: number;
  /** Flushes that failed and kept the record. */
  failures: number;
}

export interface QueuePendingQuizSubmitInput {
  attemptId: string;
  finishedAt: string;
  answers: AttemptAnswerInput[];
  now?: number;
}

function readAll(): PendingQuizSubmit[] {
  try {
    const raw = getKv().getString(PENDING_SUBMITS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PendingQuizSubmit =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as PendingQuizSubmit).attempt_id === 'string' &&
        Array.isArray((r as PendingQuizSubmit).answers),
    );
  } catch {
    return [];
  }
}

function writeAll(records: PendingQuizSubmit[]): void {
  if (records.length === 0) getKv().remove(PENDING_SUBMITS_KEY);
  else getKv().set(PENDING_SUBMITS_KEY, JSON.stringify(records));
}

/** Adds (or replaces, by attempt_id) a pending finalization. Call before the runner state is cleared. */
export function queuePendingQuizSubmit(input: QueuePendingQuizSubmitInput): void {
  const record: PendingQuizSubmit = {
    attempt_id: input.attemptId,
    finished_at: input.finishedAt,
    answers: input.answers,
    queued_at: input.now ?? Date.now(),
    failures: 0,
  };
  writeAll([...readAll().filter((r) => r.attempt_id !== input.attemptId), record]);
}

/** Number of attempts still waiting to be finalized on the server. */
export function pendingSubmitCount(): number {
  return readAll().length;
}

/** Re-reads the store so writes never overwrite records queued while a flush was running. */
function removeRecord(attemptId: string): void {
  writeAll(readAll().filter((r) => r.attempt_id !== attemptId));
}

function recordFailure(attemptId: string): void {
  writeAll(
    readAll().flatMap((r) => {
      if (r.attempt_id !== attemptId) return [r];
      const failures = r.failures + 1;
      return failures >= MAX_FLUSH_FAILURES ? [] : [{ ...r, failures }];
    }),
  );
}

let running: Promise<void> | null = null;
let rerunRequested = false;

async function finalizeOne(record: PendingQuizSubmit): Promise<void> {
  const body: QuizSubmitReq = {
    attempt_id: record.attempt_id,
    answers: record.answers,
    finished_at: record.finished_at,
  };
  try {
    await callFunction('quiz-submit', body, { idempotencyKey: `quiz-submit:${record.attempt_id}` });
    removeRecord(record.attempt_id);
  } catch (error) {
    // Already graded (here or on another device): nothing left to do.
    if (error instanceof ApiError && error.code === 'already_exists') {
      removeRecord(record.attempt_id);
      return;
    }
    // not_found (row not synced yet), offline, 5xx, auth: keep the record for the next flush.
    recordFailure(record.attempt_id);
  }
}

async function flushOnce(): Promise<void> {
  const now = Date.now();
  for (const record of readAll()) {
    if (now - record.queued_at > MAX_PENDING_AGE_MS) {
      removeRecord(record.attempt_id);
      continue;
    }
    try {
      await finalizeOne(record);
    } catch {
      // finalizeOne handles every API error; anything else must not stop the other records.
    }
  }
}

/**
 * Sends every pending quiz-submit. Safe to call often (after each sync push, after submit()):
 * a call made while a flush runs is folded into it, so there is never more than one flush in flight
 * and no record is sent twice concurrently. Never rejects.
 */
export function flushPendingQuizSubmits(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerunRequested = false;
        await flushOnce();
      } while (rerunRequested);
    } finally {
      running = null;
    }
  })();
  return running;
}
