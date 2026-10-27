// sync-push (PLT-07, MEM-02, ADR 0007). The device pushes its outbox in batches of at most 200 rows.
// Rules, from ADR 0007:
//  - review_logs are append-only: insert ON CONFLICT (id) DO NOTHING; a re-push is acked, not duplicated.
//  - reviewed_at more than 5 min ahead of server receipt is clamped to receipt and flagged clock_skew.
//  - every touched (user, card) is replayed from its full log history with the pinned FSRS code, and the
//    authoritative card_states are returned in the ack (the device overwrites its prediction).
//  - last-writer-wins fields use updated_at clamped to server time ±5 min and only move forward.
//  - auto-gradable quiz answers are re-graded here with the shared grader; AI-graded ones are queued.
//  - every kind is checked against its own table and ownership (RLS-equivalent): user_id is the caller,
//    ids are the client UUID v7 and an insert is idempotent on id. Rows the server can never store are
//    rejected with drop=true; a row that depends on data not synced yet is rejected with drop=false.
import { z } from 'zod';
import {
  ApiFailure,
  CLOCK_SKEW_TOLERANCE_MS,
  OutboxItemSchema,
  SYNC_PUSH_MAX_ITEMS,
  SyncPushResSchema,
  type SyncCardState,
  type SyncPushRes,
  isLeech,
  isSupportedSyncSchemaVersion,
  isUuid,
  isUuidV7,
  parseProfileSettings,
  replayCard,
  resolveParams,
  type ReviewLog,
  type CardState,
  type QuestionType,
} from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { canReadSubject, loadSubject, type SubjectRow } from '../shared/access.ts';
import type { Deps } from '../shared/deps.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { gradeOffline } from '../shared/grading.ts';
import { FLAG_TABLES } from '../shared/flags.ts';

const CLOCK_SKEW_MS = CLOCK_SKEW_TOLERANCE_MS;

/**
 * Largest XP one xp_event may add (spec 13 §8.1: the biggest single award is the first boss defeat, 50).
 * The server does not recompute XP (it has no event context), so a larger client amount is clamped here.
 */
export const XP_MAX_PER_EVENT = 50;

/** Postgres error codes that mean the row itself can never be stored (CHECK, NOT NULL, bad value). */
const ROW_NEVER_STORABLE = new Set(['23514', '23502', '22001', '22P02']);
/** Foreign-key violation: the parent row may still arrive from the device, so the device keeps the row. */
const FK_MISSING = '23503';

export const SyncPushEnvelopeSchema = z.object({
  schema_version: z.number().int().min(1),
  device_id: z.string().min(1).max(128),
  items: z.array(z.unknown()).min(1).max(SYNC_PUSH_MAX_ITEMS),
});

type Reject = SyncPushRes['rejected'][number];

interface PushState {
  db: SupabaseClient;
  deps: Deps;
  userId: string;
  deviceId: string;
  schemaVersion: number;
  now: Date;
  acked: Set<string>;
  rejected: Reject[];
  touchedCards: Set<string>;
  cards: Map<string, CardRow | null>;
  subjects: Map<string, boolean>;
}

interface CardRow {
  id: string;
  subject_id: string;
  created_at: string;
  deleted_at: string | null;
  personal_for_user_id: string | null;
}

/** Device timestamp for a review: a value more than 5 min ahead of receipt is replayed at receipt (ADR 0007 §6). */
export function clampReviewedAt(raw: string, now: Date): { at: Date; skew: boolean } {
  const at = new Date(raw);
  if (at.getTime() - now.getTime() > CLOCK_SKEW_MS) return { at: now, skew: true };
  return { at, skew: false };
}

/** Last-writer-wins timestamps are clamped to server time ±5 min (ADR 0007 §7). */
export function clampLww(raw: string, now: Date): Date {
  const at = new Date(raw).getTime();
  const lo = now.getTime() - CLOCK_SKEW_MS;
  const hi = now.getTime() + CLOCK_SKEW_MS;
  return new Date(Math.min(hi, Math.max(lo, at)));
}

const STATE_NUMBER: Record<CardState['state'], number> = { new: 0, learning: 1, review: 2, relearning: 3 };

async function loadCards(st: PushState, ids: string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !st.cards.has(id));
  if (missing.length === 0) return;
  const { data, error } = await st.db
    .from('cards')
    .select('id, subject_id, created_at, deleted_at, personal_for_user_id')
    .in('id', missing);
  if (error) throw error;
  const found = new Map((data as CardRow[]).map((row) => [row.id, row]));
  for (const id of missing) st.cards.set(id, found.get(id) ?? null);
}

async function subjectReadable(st: PushState, subjectId: string): Promise<boolean> {
  const cached = st.subjects.get(subjectId);
  if (cached !== undefined) return cached;
  const { data, error } = await st.db
    .from('subjects')
    .select('id, owner_profile_id, owner_class_group_id, created_by, name, content_language, is_language_subject, enem_area')
    .eq('id', subjectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  const ok = data ? await canReadSubject(st.db, st.userId, data as SubjectRow) : false;
  st.subjects.set(subjectId, ok);
  return ok;
}

/** Visibility of a card for this student: live, readable subject, and not someone else's personal card. */
async function cardAccess(st: PushState, cardId: string): Promise<{ ok: true; card: CardRow } | { ok: false; reject: Reject['code']; drop: boolean }> {
  await loadCards(st, [cardId]);
  const card = st.cards.get(cardId);
  if (!card || card.deleted_at) return { ok: false, reject: 'not_found', drop: true };
  if (card.personal_for_user_id && card.personal_for_user_id !== st.userId) return { ok: false, reject: 'forbidden', drop: true };
  if (!(await subjectReadable(st, card.subject_id))) return { ok: false, reject: 'forbidden', drop: true };
  return { ok: true, card };
}

function reject(st: PushState, id: string, code: Reject['code'], drop: boolean): void {
  st.rejected.push({ id, code, drop });
}

// ---------------------------------------------------------------- review_log (ADR 0007 §1–6)

type ReviewItem = Extract<z.infer<typeof OutboxItemSchema>, { kind: 'review_log' }>;

async function pushReviews(st: PushState, items: ReviewItem[]): Promise<void> {
  if (items.length === 0) return;
  await loadCards(st, items.map((i) => i.payload.card_id));

  const accepted: ReviewItem[] = [];
  for (const item of items) {
    const access = await cardAccess(st, item.payload.card_id);
    if (!access.ok) {
      reject(st, item.id, access.reject, access.drop);
      continue;
    }
    accepted.push(item);
  }
  if (accepted.length === 0) return;

  // An undo marker can only point at a log the server already holds or that arrives in this batch.
  const undoIds = accepted.map((i) => i.payload.undoes_log_id).filter((v): v is string => typeof v === 'string');
  const knownUndo = new Set<string>();
  if (undoIds.length > 0) {
    const { data, error } = await st.db.from('review_logs').select('id').in('id', undoIds);
    if (error) throw error;
    for (const row of data as Array<{ id: string }>) knownUndo.add(row.id);
  }
  const batchIds = new Set(accepted.map((i) => i.id));

  const rows: Record<string, unknown>[] = [];
  const rowItems: ReviewItem[] = [];
  for (const item of accepted) {
    const undo = item.payload.undoes_log_id;
    if (undo && !knownUndo.has(undo) && !batchIds.has(undo)) {
      // The log being undone has not arrived yet: keep the row and retry later (the FK needs it first).
      reject(st, item.id, 'invalid', false);
      continue;
    }
    const { at, skew } = clampReviewedAt(item.payload.reviewed_at, st.now);
    rows.push({
      id: item.id,
      user_id: st.userId,
      card_id: item.payload.card_id,
      rating: item.payload.rating,
      reviewed_at: at.toISOString(),
      client_reviewed_at: item.payload.client_reviewed_at,
      elapsed_days: item.payload.elapsed_days ?? null,
      scheduled_days: item.payload.scheduled_days ?? null,
      state_before: item.payload.state_before ?? null,
      duration_ms: item.payload.duration_ms ?? null,
      source: item.payload.source ?? 'session',
      reason: item.payload.reason ?? 'scheduled',
      hint_used: item.payload.hint_used ?? false,
      undoes_log_id: undo ?? null,
      device_id: item.payload.device_id ?? st.deviceId,
      clock_skew: skew,
      schema_version: st.schemaVersion,
    });
    rowItems.push(item);
  }
  if (rows.length === 0) return;

  // ON CONFLICT (id) DO NOTHING: a replayed row is acknowledged and changes nothing (ADR 0007 §3).
  const inserted = await st.db.from('review_logs').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (inserted.error) throw inserted.error;
  for (const item of rowItems) {
    st.acked.add(item.id);
    st.touchedCards.add(item.payload.card_id);
  }
}

/** Replays every touched card from its full history and writes card_states (ADR 0007 §4). */
async function replayTouchedCards(st: PushState): Promise<SyncCardState[]> {
  const cardIds = [...st.touchedCards];
  if (cardIds.length === 0) return [];
  const [settings, logsRes, statesRes] = await Promise.all([
    st.db.from('profiles').select('settings').eq('id', st.userId).maybeSingle(),
    st.db
      .from('review_logs')
      .select('id, card_id, rating, reviewed_at, created_at, device_id, undoes_log_id, source, reason, duration_ms')
      .eq('user_id', st.userId)
      .in('card_id', cardIds),
    st.db.from('card_states').select('card_id, suspended, hidden, introduced_at').eq('user_id', st.userId).in('card_id', cardIds),
  ]);
  if (settings.error) throw settings.error;
  if (logsRes.error) throw logsRes.error;
  if (statesRes.error) throw statesRes.error;

  const profile = parseProfileSettings(settings.data?.settings ?? {});
  const params = resolveParams({
    requestRetention: profile.memory?.desired_retention ?? 0.9,
    ...(profile.memory?.fsrs_params?.length ? { weights: profile.memory.fsrs_params } : {}),
  });

  const logs: ReviewLog[] = (logsRes.data as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    cardId: row.card_id as string,
    rating: row.rating as 1 | 2 | 3 | 4,
    reviewedAt: new Date(row.reviewed_at as string),
    receivedAt: new Date(row.created_at as string),
    deviceId: (row.device_id as string | null) ?? '',
    undoesLogId: (row.undoes_log_id as string | null) ?? null,
    source: row.source as ReviewLog['source'],
    reason: (row.reason === 'scheduled' ? 'due' : row.reason) as ReviewLog['reason'],
    durationMs: (row.duration_ms as number | null) ?? null,
  }));
  const existing = new Map((statesRes.data as Array<Record<string, unknown>>).map((r) => [r.card_id as string, r]));

  const out: SyncCardState[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const cardId of cardIds) {
    const card = st.cards.get(cardId);
    if (!card) continue;
    const cardLogs = logs.filter((l) => l.cardId === cardId);
    if (cardLogs.length === 0) continue;
    const state = replayCard(cardId, cardLogs, params, new Date(card.created_at));
    const sorted = [...cardLogs].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    const elapsedDays = prev && last ? Math.max(0, Math.floor((last.reviewedAt.getTime() - prev.reviewedAt.getTime()) / 86_400_000)) : 0;
    const prior = existing.get(cardId);
    const introducedAt = (prior?.introduced_at as string | null | undefined) ?? sorted[0]?.reviewedAt.toISOString() ?? null;
    const suspended = (prior?.suspended as boolean | undefined) ?? false;
    const hidden = (prior?.hidden as boolean | undefined) ?? false;
    const leech = isLeech(state);
    const updatedAt = st.now.toISOString();
    upserts.push({
      user_id: st.userId,
      card_id: cardId,
      subject_id: card.subject_id,
      due: state.due.toISOString(),
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: elapsedDays,
      scheduled_days: state.scheduledDays,
      reps: state.reps,
      lapses: state.lapses,
      state: STATE_NUMBER[state.state],
      learning_steps: state.learningSteps,
      last_review: state.lastReview?.toISOString() ?? null,
      suspended,
      hidden,
      is_leech: leech,
      introduced_at: introducedAt,
      last_log_id: last?.id ?? null,
      updated_at: updatedAt,
    });
    out.push({
      card_id: cardId,
      due: state.due.toISOString(),
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: elapsedDays,
      scheduled_days: state.scheduledDays,
      reps: state.reps,
      lapses: state.lapses,
      state: STATE_NUMBER[state.state],
      learning_steps: state.learningSteps,
      last_review: state.lastReview?.toISOString() ?? null,
      suspended,
      hidden,
      is_leech: leech,
      introduced_at: introducedAt,
      updated_at: updatedAt,
    });
  }
  if (upserts.length > 0) {
    const written = await st.db.from('card_states').upsert(upserts, { onConflict: 'user_id,card_id' });
    if (written.error) throw written.error;
  }
  return out;
}

// ---------------------------------------------------------------- quiz attempts and answers (PRA-01…05)

type AttemptItem = Extract<z.infer<typeof OutboxItemSchema>, { kind: 'quiz_attempt' }>;
type AnswerItem = Extract<z.infer<typeof OutboxItemSchema>, { kind: 'attempt_answer' }>;

async function pushAttempts(st: PushState, items: AttemptItem[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    const quiz = await st.db.from('quizzes').select('id, owner_id').eq('id', p.quiz_id).maybeSingle();
    if (quiz.error) throw quiz.error;
    if (!quiz.data) {
      // The quiz may still be on its way from the device: keep the row for a retry.
      reject(st, item.id, 'not_found', false);
      continue;
    }
    if (quiz.data.owner_id !== st.userId) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    const existing = await st.db.from('quiz_attempts').select('id, user_id, status').eq('id', item.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      if (existing.data.user_id !== st.userId) {
        reject(st, item.id, 'forbidden', true);
        continue;
      }
      // Once submitted (by quiz-submit), the server owns the attempt: later device rows only add pauses.
      if (existing.data.status === 'in_progress' && p.status !== 'submitted') {
        await st.db
          .from('quiz_attempts')
          .update({ status: p.status, finished_at: p.finished_at ?? null, paused_seconds: p.paused_seconds ?? 0 })
          .eq('id', item.id);
      }
      st.acked.add(item.id);
      continue;
    }
    const inserted = await st.db.from('quiz_attempts').insert({
      id: item.id,
      user_id: st.userId,
      quiz_id: p.quiz_id,
      // A device cannot submit; quiz-submit grades the attempt, so 'submitted' is stored as in_progress.
      status: p.status === 'submitted' ? 'in_progress' : p.status,
      started_at: p.started_at,
      finished_at: p.finished_at ?? null,
      paused_seconds: p.paused_seconds ?? 0,
      device_id: p.device_id,
    });
    if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
    st.acked.add(item.id);
  }
}

async function pushAnswers(st: PushState, items: AnswerItem[]): Promise<void> {
  const pendingGrading: string[] = [];
  for (const item of items) {
    const p = item.payload;
    const existing = await st.db.from('attempt_answers').select('id, attempt_id, question_id').eq('id', item.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      st.acked.add(item.id);
      continue;
    }

    const attempt = await st.db.from('quiz_attempts').select('id, user_id, quiz_id, status').eq('id', p.attempt_id).maybeSingle();
    if (attempt.error) throw attempt.error;
    if (!attempt.data) {
      reject(st, item.id, 'not_found', false);
      continue;
    }
    if (attempt.data.user_id !== st.userId) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    if (attempt.data.status !== 'in_progress') {
      reject(st, item.id, 'stale', true);
      continue;
    }
    const quiz = await st.db.from('quizzes').select('question_ids').eq('id', attempt.data.quiz_id as string).maybeSingle();
    if (quiz.error) throw quiz.error;
    const questionIds = (quiz.data?.question_ids as string[] | undefined) ?? [];
    if (!questionIds.includes(p.question_id)) {
      reject(st, item.id, 'invalid', true);
      continue;
    }
    const question = await st.db
      .from('questions')
      .select('id, type, payload, subject_id, personal_for_user_id, deleted_at, version')
      .eq('id', p.question_id)
      .maybeSingle();
    if (question.error) throw question.error;
    if (!question.data || question.data.deleted_at) {
      reject(st, item.id, 'not_found', false);
      continue;
    }
    if (!(await subjectReadable(st, question.data.subject_id as string))) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }

    const type = question.data.type as QuestionType;
    const grading = gradeOffline(type, question.data.payload, p.response ?? null, p.hints_used ?? 0, p.solution_viewed ?? false);
    const row = {
      id: item.id,
      attempt_id: p.attempt_id,
      user_id: st.userId,
      question_id: p.question_id,
      question_version: p.question_version,
      response: p.response ?? null,
      correct: grading.correct,
      score: grading.score,
      grading_status: grading.status,
      confidence: p.confidence ?? null,
      time_spent_ms: p.time_spent_ms,
      hints_used: p.hints_used ?? 0,
      solution_viewed: p.solution_viewed ?? false,
      marked_for_review: p.marked_for_review ?? false,
      input_mode: p.input_mode ?? 'typed',
      essay_id: p.essay_id ?? null,
      answered_at: p.answered_at,
    };
    const inserted = await st.db.from('attempt_answers').insert(row);
    if (inserted.error) {
      // 23505 on (attempt_id, question_id): the same question was answered under another id. Already processed.
      if (inserted.error.code === '23505') {
        st.acked.add(item.id);
        continue;
      }
      throw inserted.error;
    }
    st.acked.add(item.id);
    if (grading.status === 'pending') pendingGrading.push(item.id);
  }
  for (const id of pendingGrading) {
    await st.deps.enqueue('grading.answer', { attempt_answer_id: id }, { singletonKey: id, retryLimit: 2 });
  }
}

// ---------------------------------------------------------------- last-writer-wins edits

type LwwItem = Extract<
  z.infer<typeof OutboxItemSchema>,
  { kind: 'plan_item_status' | 'card_state_flag' | 'card_override' | 'node_user_setting' | 'subject_user_setting' | 'study_preferences' }
>;

async function pushLww(st: PushState, items: LwwItem[]): Promise<void> {
  for (const item of items) {
    const at = clampLww(item.payload.updated_at, st.now).toISOString();
    if (item.kind === 'plan_item_status') {
      const p = item.payload;
      const patch: Record<string, unknown> = { updated_at: at };
      if (p.status !== undefined) patch.status = p.status;
      if (p.pinned !== undefined) patch.pinned = p.pinned;
      const updated = await st.db
        .from('plan_items')
        .update(patch)
        .eq('id', p.plan_item_id)
        .eq('user_id', st.userId)
        .lt('updated_at', at)
        .select('id');
      if (updated.error) throw updated.error;
      if ((updated.data ?? []).length > 0) {
        st.acked.add(item.id);
        continue;
      }
      const exists = await st.db.from('plan_items').select('id, user_id').eq('id', p.plan_item_id).maybeSingle();
      if (exists.error) throw exists.error;
      if (!exists.data) reject(st, item.id, 'not_found', true);
      else if (exists.data.user_id !== st.userId) reject(st, item.id, 'forbidden', true);
      else st.acked.add(item.id); // a newer edit already won
      continue;
    }

    if (item.kind === 'card_state_flag') {
      const p = item.payload;
      const access = await cardAccess(st, p.card_id);
      if (!access.ok) {
        reject(st, item.id, access.reject, access.drop);
        continue;
      }
      const existing = await st.db.from('card_states').select('updated_at').eq('user_id', st.userId).eq('card_id', p.card_id).maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) {
        // A card the device flagged before any review: create the row with the FSRS defaults (due now).
        const created = await st.db.from('card_states').insert({
          user_id: st.userId,
          card_id: p.card_id,
          subject_id: access.card.subject_id,
          due: st.now.toISOString(),
          [p.field]: p.value,
          updated_at: at,
        });
        if (created.error && created.error.code !== '23505') throw created.error;
      } else if (new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
        const updated = await st.db
          .from('card_states')
          .update({ [p.field]: p.value, updated_at: at })
          .eq('user_id', st.userId)
          .eq('card_id', p.card_id);
        if (updated.error) throw updated.error;
      }
      st.acked.add(item.id);
      continue;
    }

    if (item.kind === 'card_override') {
      // MEM-01: the student's own front/back/media for a card. Keyed by (user, card), so no id column.
      const p = item.payload;
      const access = await cardAccess(st, p.card_id);
      if (!access.ok) {
        reject(st, item.id, access.reject, access.drop);
        continue;
      }
      if (p.media !== undefined && p.media !== null && typeof p.media !== 'object') {
        reject(st, item.id, 'invalid', true); // card_overrides.media is a JSON object (DB check)
        continue;
      }
      const fields: Record<string, unknown> = {};
      if (p.front !== undefined) fields.front = p.front;
      if (p.back !== undefined) fields.back = p.back;
      if (p.media !== undefined) fields.media = p.media;
      await guardRow(st, item.id, async () => {
        const existing = await st.db.from('card_overrides').select('updated_at').eq('user_id', st.userId).eq('card_id', p.card_id).maybeSingle();
        if (existing.error) throw existing.error;
        if (!existing.data) {
          const created = await st.db.from('card_overrides').insert({ user_id: st.userId, card_id: p.card_id, ...fields, updated_at: at });
          if (created.error && created.error.code !== '23505') throw created.error;
        } else if (new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
          const updated = await st.db.from('card_overrides').update({ ...fields, updated_at: at }).eq('user_id', st.userId).eq('card_id', p.card_id);
          if (updated.error) throw updated.error;
        }
        st.acked.add(item.id);
      });
      continue;
    }

    if (item.kind === 'node_user_setting') {
      const p = item.payload;
      const node = await st.db.from('knowledge_nodes').select('id, subject_id').eq('id', p.node_id).is('deleted_at', null).maybeSingle();
      if (node.error) throw node.error;
      if (!node.data || !(await subjectReadable(st, node.data.subject_id as string))) {
        reject(st, item.id, 'not_found', true);
        continue;
      }
      const existing = await st.db.from('node_user_settings').select('updated_at').eq('user_id', st.userId).eq('node_id', p.node_id).maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data || new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
        const written = await st.db.from('node_user_settings').upsert(
          { user_id: st.userId, node_id: p.node_id, excluded: p.excluded, updated_at: at },
          { onConflict: 'user_id,node_id' },
        );
        if (written.error) throw written.error;
      }
      st.acked.add(item.id);
      continue;
    }

    if (item.kind === 'subject_user_setting') {
      const p = item.payload;
      if (!(await subjectReadable(st, p.subject_id))) {
        reject(st, item.id, 'not_found', true);
        continue;
      }
      const existing = await st.db.from('subject_user_settings').select('updated_at').eq('user_id', st.userId).eq('subject_id', p.subject_id).maybeSingle();
      if (existing.error) throw existing.error;
      const fields: Record<string, unknown> = { updated_at: at };
      if (p.pinned !== undefined) fields.pinned = p.pinned;
      if (p.sort_order !== undefined) fields.sort_order = p.sort_order;
      if (p.archived_at !== undefined) fields.archived_at = p.archived_at;
      if (!existing.data) {
        const created = await st.db.from('subject_user_settings').insert({ user_id: st.userId, subject_id: p.subject_id, ...fields });
        if (created.error && created.error.code !== '23505') throw created.error;
      } else if (new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
        const updated = await st.db.from('subject_user_settings').update(fields).eq('user_id', st.userId).eq('subject_id', p.subject_id);
        if (updated.error) throw updated.error;
      }
      st.acked.add(item.id);
      continue;
    }

    // study_preferences: partial, LWW on the row (one row per student).
    const { updated_at: _ignored, ...fields } = item.payload;
    const patch: Record<string, unknown> = { ...fields, updated_at: at };
    const current = await st.db.from('study_preferences').select('updated_at').eq('user_id', st.userId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) {
      const created = await st.db.from('study_preferences').insert({ user_id: st.userId, ...patch });
      if (created.error && created.error.code !== '23505') throw created.error;
    } else if (new Date(current.data.updated_at as string).getTime() < new Date(at).getTime()) {
      const updated = await st.db.from('study_preferences').update(patch).eq('user_id', st.userId);
      if (updated.error) throw updated.error;
    }
    st.acked.add(item.id);
  }
}

// ---------------------------------------------------------------- kinds with their own table

type OutboxKind = z.infer<typeof OutboxItemSchema>['kind'];
type Item<K extends OutboxKind> = Extract<z.infer<typeof OutboxItemSchema>, { kind: K }>;
type Access = { ok: true } | { ok: false; reject: Reject['code']; drop: boolean };

/**
 * Runs the writes of one row. A row the database can never store is rejected with drop=true; a row whose
 * parent (foreign key) has not arrived is kept with drop=false. Any other error fails the batch, as before.
 */
async function guardRow(st: PushState, id: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && ROW_NEVER_STORABLE.has(code)) reject(st, id, 'invalid', true);
    else if (code === FK_MISSING) reject(st, id, 'not_found', false);
    else throw error;
  }
}

/** An id-keyed row (client UUID v7): `mine` means the push is an idempotent ack, `theirs` is refused. */
async function ownership(st: PushState, table: string, id: string, ownerColumn = 'user_id'): Promise<'mine' | 'theirs' | 'none'> {
  const { data, error } = await st.db.from(table).select(`id, ${ownerColumn}`).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return 'none';
  return (data as unknown as Record<string, unknown>)[ownerColumn] === st.userId ? 'mine' : 'theirs';
}

/** The id when the caller owns that row, otherwise null: a dangling link is dropped, the row is kept. */
async function ownedId(st: PushState, table: string, id: string): Promise<string | null> {
  const { data, error } = await st.db.from(table).select('id').eq('id', id).eq('user_id', st.userId).maybeSingle();
  if (error) throw error;
  return data ? id : null;
}

/** Shared by `ownership` results: refuse another student's row, ack the caller's own. Returns true when handled. */
function handledByOwnership(st: PushState, id: string, owner: 'mine' | 'theirs' | 'none'): boolean {
  if (owner === 'theirs') {
    reject(st, id, 'forbidden', true);
    return true;
  }
  if (owner === 'mine') {
    st.acked.add(id);
    return true;
  }
  return false;
}

/** Access to the item a feed impression refers to (FED-01). Same rules as the reads the student can do. */
async function feedRefAccess(st: PushState, kind: 'feed_item' | 'card' | 'mistake', refId: string): Promise<Access> {
  if (kind === 'card') return cardAccess(st, refId);
  if (kind === 'mistake') {
    const mistake = await st.db.from('mistakes').select('id').eq('id', refId).eq('user_id', st.userId).maybeSingle();
    if (mistake.error) throw mistake.error;
    return mistake.data ? { ok: true } : { ok: false, reject: 'not_found', drop: true };
  }
  const feed = await st.db.from('feed_items').select('id, subject_id, personal_for_user_id').eq('id', refId).is('deleted_at', null).maybeSingle();
  if (feed.error) throw feed.error;
  if (!feed.data) return { ok: false, reject: 'not_found', drop: true };
  const personal = feed.data.personal_for_user_id as string | null;
  if (personal && personal !== st.userId) return { ok: false, reject: 'not_found', drop: true };
  if (!(await subjectReadable(st, feed.data.subject_id as string))) return { ok: false, reject: 'forbidden', drop: true };
  return { ok: true };
}

// flag (TRU-02): content_flags. The same item rules as flag-create; the triage job is queued like there.
async function pushFlags(st: PushState, items: Item<'flag'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    if (handledByOwnership(st, item.id, await ownership(st, 'content_flags', item.id, 'reporter_id'))) continue;
    const spec = FLAG_TABLES[p.item_type];
    if (!spec) {
      reject(st, item.id, 'invalid', true);
      continue;
    }
    await guardRow(st, item.id, async () => {
      const found = await st.db.from(spec.table).select(spec.select).eq('id', p.item_id).is('deleted_at', null).maybeSingle();
      if (found.error) throw found.error;
      const row = found.data as Record<string, unknown> | null;
      const personal = row?.personal_for_user_id as string | null | undefined;
      const subject = row ? await loadSubject(st.db, row.subject_id as string) : null;
      if (!row || (personal && personal !== st.userId) || !subject || !(await canReadSubject(st.db, st.userId, subject))) {
        reject(st, item.id, 'not_found', true);
        return;
      }
      // One open flag per (item, reporter): a flag this student already has open is not added again.
      const open = await st.db
        .from('content_flags')
        .select('id')
        .eq('item_type', p.item_type)
        .eq('item_id', p.item_id)
        .eq('reporter_id', st.userId)
        .in('status', ['open', 'triaged', 'hidden_pending'])
        .maybeSingle();
      if (open.error) throw open.error;
      if (open.data) {
        st.acked.add(item.id);
        return;
      }
      const inserted = await st.db.from('content_flags').insert({
        id: item.id,
        item_type: p.item_type,
        item_id: p.item_id,
        item_version: spec.versioned ? Number(row.version ?? 1) : 1,
        class_group_id: subject.owner_class_group_id,
        reporter_id: st.userId,
        reason: p.reason,
        comment: p.comment ?? null,
        status: 'open',
      });
      if (inserted.error) {
        if (inserted.error.code !== '23505') throw inserted.error;
        st.acked.add(item.id);
        return;
      }
      st.acked.add(item.id);
      await st.deps.enqueue('flag.triage', { flag_id: item.id }, { singletonKey: item.id, retryLimit: 2 });
    });
  }
}

// xp_event (MOT-01, SOC-08): xp_events. The client amount is clamped; (user, ref, feature) is awarded once.
async function pushXp(st: PushState, items: Item<'xp_event'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    // Zero or negative: nothing to award (for example a card repeated within 10 min). Acked, not stored.
    if (p.amount <= 0) {
      st.acked.add(item.id);
      continue;
    }
    if (p.ref_type.length > 40) {
      reject(st, item.id, 'invalid', true); // xp_events.ref_type is at most 40 characters (DB check)
      continue;
    }
    if (handledByOwnership(st, item.id, await ownership(st, 'xp_events', item.id))) continue;
    const occurredAt = clampReviewedAt(p.occurred_at, st.now).at;
    await guardRow(st, item.id, async () => {
      const inserted = await st.db.from('xp_events').upsert(
        {
          id: item.id,
          user_id: st.userId,
          amount: Math.min(p.amount, XP_MAX_PER_EVENT),
          source_feature: p.source_feature,
          ref_type: p.ref_type,
          ref_id: p.ref_id,
          occurred_at: occurredAt.toISOString(),
          local_date: p.local_date,
          in_quiet_hours: p.in_quiet_hours,
        },
        { onConflict: 'user_id,ref_type,ref_id,source_feature', ignoreDuplicates: true },
      );
      if (inserted.error) throw inserted.error;
      st.acked.add(item.id);
    });
  }
}

// study_session (GOL-05, WEL-01/02, MOT-01): study_sessions. Links to plans and goals are kept only when owned.
async function pushStudySessions(st: PushState, items: Item<'study_session'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    if (handledByOwnership(st, item.id, await ownership(st, 'study_sessions', item.id))) continue;
    await guardRow(st, item.id, async () => {
      const inserted = await st.db.from('study_sessions').insert({
        id: item.id,
        user_id: st.userId,
        kind: p.kind,
        plan_item_id: p.plan_item_id ? await ownedId(st, 'plan_items', p.plan_item_id) : null,
        goal_id: p.goal_id ? await ownedId(st, 'goals', p.goal_id) : null,
        started_at: p.started_at,
        ended_at: p.ended_at ?? null,
        active_minutes: p.active_minutes ?? 0,
        activities: p.activities ?? [],
        planned_focus_minutes: p.planned_focus_minutes ?? null,
        cycles_planned: p.cycles_planned ?? null,
        cycles_done: p.cycles_done ?? null,
        interruptions: p.interruptions ?? null,
        blocked_attempts: p.blocked_attempts ?? null,
        dnd_used: p.dnd_used ?? false,
        updated_at: st.now.toISOString(),
      });
      if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
      st.acked.add(item.id);
    });
  }
}

// topic_read (LRN-01.11): topic_reads, append-only. The node must be readable by the student.
async function pushTopicReads(st: PushState, items: Item<'topic_read'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    if (handledByOwnership(st, item.id, await ownership(st, 'topic_reads', item.id))) continue;
    const node = await st.db.from('knowledge_nodes').select('id, subject_id').eq('id', p.node_id).is('deleted_at', null).maybeSingle();
    if (node.error) throw node.error;
    if (!node.data) {
      reject(st, item.id, 'not_found', true);
      continue;
    }
    if (!(await subjectReadable(st, node.data.subject_id as string))) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    await guardRow(st, item.id, async () => {
      const inserted = await st.db.from('topic_reads').insert({
        id: item.id,
        user_id: st.userId,
        node_id: p.node_id,
        depth: p.depth,
        read_at: p.read_at,
        seconds: p.seconds,
      });
      if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
      st.acked.add(item.id);
    });
  }
}

// podcast_play (INT-01): podcast_plays, one row per (user, episode), last writer wins on updated_at (clamped).
// The episode must be one the caller can read (a personal Revisão pra prova episode is its owner's only).
async function pushPodcastPlays(st: PushState, items: Item<'podcast_play'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    const episode = await st.db.from('podcast_episodes').select('id, subject_id, owner_user_id').eq('id', p.episode_id).maybeSingle();
    if (episode.error) throw episode.error;
    if (!episode.data) {
      reject(st, item.id, 'not_found', true);
      continue;
    }
    const owner = episode.data.owner_user_id as string | null;
    if ((owner && owner !== st.userId) || !(await subjectReadable(st, episode.data.subject_id as string))) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    const at = clampLww(p.updated_at, st.now).toISOString();
    await guardRow(st, item.id, async () => {
      const existing = await st.db.from('podcast_plays').select('updated_at').eq('user_id', st.userId).eq('episode_id', p.episode_id).maybeSingle();
      if (existing.error) throw existing.error;
      const row: Record<string, unknown> = { position_ms: p.position_ms, updated_at: at, deleted_at: null };
      if (p.completed_at !== undefined) row.completed_at = p.completed_at;
      if (p.downloaded !== undefined) row.downloaded = p.downloaded;
      if (!existing.data) {
        const inserted = await st.db.from('podcast_plays').insert({ user_id: st.userId, episode_id: p.episode_id, ...row });
        if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
      } else if (new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
        const updated = await st.db.from('podcast_plays').update(row).eq('user_id', st.userId).eq('episode_id', p.episode_id);
        if (updated.error) throw updated.error;
      }
      st.acked.add(item.id);
    });
  }
}

// feed_impression (FED-01): feed_impressions, append-only. The feed's visit id is not a study session, so a
// session_id that is not one of the student's study sessions is stored as null instead of refusing the row.
async function pushFeedImpressions(st: PushState, items: Item<'feed_impression'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    if (handledByOwnership(st, item.id, await ownership(st, 'feed_impressions', item.id))) continue;
    if (!p.action) {
      reject(st, item.id, 'invalid', true); // the table needs an action; the device always sends one
      continue;
    }
    const ref = await feedRefAccess(st, p.item_kind, p.item_ref_id);
    if (!ref.ok) {
      reject(st, item.id, ref.reject, ref.drop);
      continue;
    }
    await guardRow(st, item.id, async () => {
      const inserted = await st.db.from('feed_impressions').insert({
        id: item.id,
        user_id: st.userId,
        feed_item_id: p.item_kind === 'feed_item' ? p.item_ref_id : null,
        item_kind: p.item_kind,
        item_ref_id: p.item_ref_id,
        session_id: await ownedId(st, 'study_sessions', p.session_id),
        shown_at: p.shown_at,
        dwell_ms: p.dwell_ms ?? 0,
        action: p.action,
        helpful: p.helpful ?? null,
      });
      if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
      st.acked.add(item.id);
    });
  }
}

// note_highlight (LRN-01.10): note_highlights. Last writer wins on updated_at, like the other edits.
async function pushHighlights(st: PushState, items: Item<'note_highlight'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    const existing = await st.db.from('note_highlights').select('id, user_id, updated_at').eq('id', item.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data && existing.data.user_id !== st.userId) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    const note = await st.db.from('notes').select('id, subject_id').eq('id', p.note_id).is('deleted_at', null).maybeSingle();
    if (note.error) throw note.error;
    if (!note.data) {
      reject(st, item.id, 'not_found', true);
      continue;
    }
    if (!(await subjectReadable(st, note.data.subject_id as string))) {
      reject(st, item.id, 'forbidden', true);
      continue;
    }
    const at = clampLww(p.updated_at, st.now).toISOString();
    await guardRow(st, item.id, async () => {
      const values = {
        note_id: p.note_id,
        start: p.start,
        end: p.end,
        quote: p.quote,
        color: p.color,
        orphaned: p.orphaned ?? false,
        deleted_at: p.deleted_at ?? null,
        updated_at: at,
      };
      if (!existing.data) {
        const created = await st.db.from('note_highlights').insert({ id: item.id, user_id: st.userId, ...values });
        if (created.error && created.error.code !== '23505') throw created.error;
      } else if (new Date(existing.data.updated_at as string).getTime() < new Date(at).getTime()) {
        const updated = await st.db.from('note_highlights').update(values).eq('id', item.id).eq('user_id', st.userId);
        if (updated.error) throw updated.error;
      }
      st.acked.add(item.id);
    });
  }
}

// mistake_update (PRA-04): mistakes. Only the student's own cause and note change; the server keeps one open
// mistake per (user, question), so the row is found by its question.
async function pushMistakeUpdates(st: PushState, items: Item<'mistake_update'>[]): Promise<void> {
  for (const item of items) {
    const p = item.payload;
    const found = await st.db
      .from('mistakes')
      .select('id, updated_at')
      .eq('user_id', st.userId)
      .eq('question_id', p.question_id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (found.error) throw found.error;
    const mistake = found.data as { id: string; updated_at: string } | null;
    if (!mistake) {
      reject(st, item.id, 'not_found', true);
      continue;
    }
    const at = clampLww(p.updated_at, st.now);
    await guardRow(st, item.id, async () => {
      if (new Date(mistake.updated_at).getTime() < at.getTime()) {
        const patch: Record<string, unknown> = { updated_at: at.toISOString() };
        if (p.cause !== undefined) {
          patch.cause = p.cause;
          patch.cause_source = 'user';
        }
        if (p.user_note !== undefined) patch.user_note = p.user_note;
        const updated = await st.db.from('mistakes').update(patch).eq('id', mistake.id).eq('user_id', st.userId);
        if (updated.error) throw updated.error;
      }
      st.acked.add(item.id);
    });
  }
}

export const handler = defineFunction<z.infer<typeof SyncPushEnvelopeSchema>>({
  name: 'sync-push',
  mutating: true,
  input: SyncPushEnvelopeSchema,
  run: async (ctx) => {
    const { deps } = ctx;
    const envelope = ctx.input;
    if (!isSupportedSyncSchemaVersion(envelope.schema_version)) throw new ApiFailure('app_update_required');

    const st: PushState = {
      db: deps.db,
      deps,
      userId: ctx.user.userId,
      deviceId: envelope.device_id,
      schemaVersion: envelope.schema_version,
      now: ctx.now,
      acked: new Set(),
      rejected: [],
      touchedCards: new Set(),
      cards: new Map(),
      subjects: new Map(),
    };

    // Validate each row with its own schema. A row that fails is rejected; the batch goes on.
    const reviews: ReviewItem[] = [];
    const attempts: AttemptItem[] = [];
    const answers: AnswerItem[] = [];
    const lww: LwwItem[] = [];
    const mistakeUpdates: Item<'mistake_update'>[] = [];
    const highlights: Item<'note_highlight'>[] = [];
    const flags: Item<'flag'>[] = [];
    const xp: Item<'xp_event'>[] = [];
    const sessions: Item<'study_session'>[] = [];
    const topicReads: Item<'topic_read'>[] = [];
    const impressions: Item<'feed_impression'>[] = [];
    const plays: Item<'podcast_play'>[] = [];
    for (const raw of envelope.items) {
      const parsed = OutboxItemSchema.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown })?.id;
        // A row without a usable id cannot be reported back; the device keeps it until it has one.
        if (typeof id === 'string' && isUuidV7(id)) reject(st, id, 'invalid', true);
        continue;
      }
      const item = parsed.data;
      switch (item.kind) {
        case 'review_log':
          reviews.push(item);
          break;
        case 'quiz_attempt':
          attempts.push(item);
          break;
        case 'attempt_answer':
          answers.push(item);
          break;
        case 'plan_item_status':
        case 'card_state_flag':
        case 'card_override':
        case 'node_user_setting':
        case 'subject_user_setting':
        case 'study_preferences':
          lww.push(item);
          break;
        case 'mistake_update':
          mistakeUpdates.push(item);
          break;
        case 'note_highlight':
          highlights.push(item);
          break;
        case 'flag':
          flags.push(item);
          break;
        case 'xp_event':
          xp.push(item);
          break;
        case 'study_session':
          sessions.push(item);
          break;
        case 'topic_read':
          topicReads.push(item);
          break;
        case 'feed_impression':
          impressions.push(item);
          break;
        case 'podcast_play':
          plays.push(item);
          break;
      }
    }

    // Order matters: attempts before the answers that reference them, reviews before the replay, study
    // sessions before the feed impressions that may link to them.
    await pushReviews(st, reviews);
    await pushAttempts(st, attempts);
    await pushAnswers(st, answers);
    await pushLww(st, lww);
    await pushMistakeUpdates(st, mistakeUpdates);
    await pushHighlights(st, highlights);
    await pushFlags(st, flags);
    await pushXp(st, xp);
    await pushStudySessions(st, sessions);
    await pushTopicReads(st, topicReads);
    await pushFeedImpressions(st, impressions);
    await pushPodcastPlays(st, plays);
    const cardStates = await replayTouchedCards(st);

    const body: SyncPushRes = {
      acked: [...st.acked].filter((id) => isUuid(id)),
      rejected: st.rejected,
      card_states: cardStates,
      server_time: st.now.toISOString(),
    };
    // Shape check against the shared contract: a bug here must not reach the device.
    SyncPushResSchema.parse(body);
    return ctx.json(body);
  },
});

export default handler;
