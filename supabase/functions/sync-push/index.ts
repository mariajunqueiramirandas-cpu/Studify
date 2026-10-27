// sync-push (PLT-07, MEM-02, ADR 0007). The device pushes its outbox in batches of at most 200 rows.
// Rules, from ADR 0007:
//  - review_logs are append-only: insert ON CONFLICT (id) DO NOTHING; a re-push is acked, not duplicated.
//  - reviewed_at more than 5 min ahead of server receipt is clamped to receipt and flagged clock_skew.
//  - every touched (user, card) is replayed from its full log history with the pinned FSRS code, and the
//    authoritative card_states are returned in the ack (the device overwrites its prediction).
//  - last-writer-wins fields use updated_at clamped to server time ±5 min and only move forward.
//  - auto-gradable quiz answers are re-graded here with the shared grader; AI-graded ones are queued.
// Kinds whose tables are not in the migrations yet are rejected with drop=false, so the device keeps the
// row and retries after the server catches up (api §4.1 rejected[].drop).
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
  gradeAnswer,
  isLocallyGraded,
  parseProfileSettings,
  parseQuestionPayload,
  parseQuestionResponse,
  replayCard,
  resolveParams,
  type ReviewLog,
  type CardState,
  type QuestionType,
} from '@studify/shared';
import { defineFunction } from '../_shared/http.ts';
import { canReadSubject, type SubjectRow } from '../_shared/access.ts';
import type { Deps } from '../_shared/deps.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { gradeOffline } from '../_shared/grading.ts';

const SYNC_KINDS_WITHOUT_TABLE = new Set([
  'flag',
  'feed_impression',
  'xp_event',
  'study_session',
  'topic_read',
  'podcast_play',
  'card_override',
  'mistake_update',
  'note_highlight',
]);

const CLOCK_SKEW_MS = CLOCK_SKEW_TOLERANCE_MS;

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
  { kind: 'plan_item_status' | 'card_state_flag' | 'node_user_setting' | 'subject_user_setting' | 'study_preferences' }
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
    for (const raw of envelope.items) {
      const parsed = OutboxItemSchema.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown })?.id;
        // A row without a usable id cannot be reported back; the device keeps it until it has one.
        if (typeof id === 'string' && isUuidV7(id)) reject(st, id, 'invalid', true);
        continue;
      }
      const item = parsed.data;
      if (SYNC_KINDS_WITHOUT_TABLE.has(item.kind)) {
        // The table ships in a later migration: keep the row on the device and retry.
        reject(st, item.id, 'invalid', false);
        continue;
      }
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
        case 'node_user_setting':
        case 'subject_user_setting':
        case 'study_preferences':
          lww.push(item);
          break;
      }
    }

    // Order matters: attempts before the answers that reference them, reviews before the replay.
    await pushReviews(st, reviews);
    await pushAttempts(st, attempts);
    await pushAnswers(st, answers);
    await pushLww(st, lww);
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

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
