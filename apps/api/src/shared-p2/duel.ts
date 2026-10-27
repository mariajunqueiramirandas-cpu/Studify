// Duel timing, scoring, answer recording and completion (SOC-02, spec 10 §8.2, learning-engine §18.1).
// Times come from the server clock only: `served_at` from private.question_served, receipt = now().
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure, duelAnswerSeconds, duelPoints, SOCIAL, suggestMistakeCause } from '@studify/shared';
import type { P2Deps } from './deps.ts';
import { gradeQuestion, parseResponse, payloadOf, type QuestionRow } from './questions.ts';
import { pushTo, scheduleAt } from './jobs.ts';

/** Per-question limit (SOC-02.4). */
export const DUEL_QUESTION_SECONDS = SOCIAL.duelMaxSeconds;
/** Answers after deadline_at + this grace are timeouts (api §4.7, data-model §5.7). Spec 10 §8.2 says 3 s; see the report. */
export const DUEL_GRACE_MS = 1_500;
export const DUEL_EXPIRY_HOURS = 48;
export const DUEL_MAX_POINTS = 150;
export const DUEL_LIMITS = { openPerUser: 10, newPerDay: 20, openPerPair: 3 } as const;

export interface DuelRow {
  id: string;
  class_group_id: string;
  challenger_id: string;
  opponent_id: string;
  quiz_id: string;
  status: 'waiting_opponent' | 'declined' | 'finished' | 'expired' | 'cancelled';
  expires_at: string;
  challenger_attempt_id: string | null;
  opponent_attempt_id: string | null;
  challenger_score: number | null;
  opponent_score: number | null;
  winner_id: string | null;
  rematch_of: string | null;
}

export interface AttemptRow {
  id: string;
  user_id: string;
  quiz_id: string;
  status: string;
  device_id: string;
}

export interface QuizRow {
  id: string;
  kind: string;
  question_ids: string[];
}

const DUEL_COLUMNS =
  'id, class_group_id, challenger_id, opponent_id, quiz_id, status, expires_at, challenger_attempt_id, opponent_attempt_id, challenger_score, opponent_score, winner_id, rematch_of';

export async function loadDuel(db: SupabaseClient, duelId: string): Promise<DuelRow | null> {
  const { data, error } = await db.from('duels').select(DUEL_COLUMNS).eq('id', duelId).maybeSingle();
  if (error) throw error;
  return (data as DuelRow | null) ?? null;
}

export async function duelForQuiz(db: SupabaseClient, quizId: string): Promise<DuelRow | null> {
  const { data, error } = await db.from('duels').select(DUEL_COLUMNS).eq('quiz_id', quizId).maybeSingle();
  if (error) throw error;
  return (data as DuelRow | null) ?? null;
}

/** An attempt that belongs to the caller (IDOR: another user's attempt is 404). */
export async function loadOwnAttempt(db: SupabaseClient, attemptId: string, userId: string): Promise<AttemptRow> {
  const { data, error } = await db.from('quiz_attempts').select('id, user_id, quiz_id, status, device_id').eq(
    'id',
    attemptId,
  ).maybeSingle();
  if (error) throw error;
  if (!data || data.user_id !== userId) throw new ApiFailure('not_found');
  return data as AttemptRow;
}

export async function loadQuiz(db: SupabaseClient, quizId: string): Promise<QuizRow | null> {
  const { data, error } = await db.from('quizzes').select('id, kind, question_ids').eq('id', quizId).is(
    'deleted_at',
    null,
  ).maybeSingle();
  if (error) throw error;
  return (data as QuizRow | null) ?? null;
}

export function isDuelOpen(duel: DuelRow, now: Date): boolean {
  return duel.status === 'waiting_opponent' && new Date(duel.expires_at).getTime() > now.getTime();
}

/** Deadline of a question served at `servedAt` (served + 30 s). */
export function questionDeadline(servedAt: Date): Date {
  return new Date(servedAt.getTime() + DUEL_QUESTION_SECONDS * 1000);
}

/** Receipt after deadline + grace is a timeout (scores 0). */
export function isTimeoutAt(receivedMs: number, deadlineMs: number): boolean {
  return receivedMs > deadlineMs + DUEL_GRACE_MS;
}

export interface DuelWinnerResult {
  winner_id: string | null;
  result_for_challenger: 'win' | 'lose' | 'tie';
}

/** Highest total wins; equal totals are a tie with winner_id null (SOC-02.6). */
export function duelOutcome(
  duel: Pick<DuelRow, 'challenger_id' | 'opponent_id'>,
  challengerScore: number,
  opponentScore: number,
): DuelWinnerResult {
  if (challengerScore === opponentScore) return { winner_id: null, result_for_challenger: 'tie' };
  return challengerScore > opponentScore
    ? { winner_id: duel.challenger_id, result_for_challenger: 'win' }
    : { winner_id: duel.opponent_id, result_for_challenger: 'lose' };
}

export interface RecordAnswerArgs {
  deps: P2Deps;
  attempt: AttemptRow;
  question: QuestionRow;
  servedAt: Date;
  /** Raw client response, or null when the question timed out or was skipped. */
  response: unknown | null;
  answerId: string;
  timeout: boolean;
  now: Date;
}

export type RecordAnswerResult =
  | { kind: 'recorded'; correct: boolean; points: number; timeout: boolean }
  | { kind: 'existing' };

/**
 * Writes one duel answer (attempt_answers), its Caderno entry for a wrong answer (SOC-02.8), the mastery
 * evidence (source duel, weight 0.75) and the debounced mastery recompute. Returns `existing` when the
 * question was already answered for this attempt, so retries never double-count.
 */
export async function recordDuelAnswer(args: RecordAnswerArgs): Promise<RecordAnswerResult> {
  const { deps, attempt, question } = args;
  const db = deps.db;
  const parsed = !args.timeout && args.response !== null ? parseResponse(question, args.response) : null;
  const outcome = parsed ? gradeQuestion(question, parsed) : { correct: false, score: 0 };
  const servedMs = args.servedAt.getTime();
  const nowMs = args.now.getTime();
  const points = args.timeout
    ? 0
    : duelPoints(outcome.correct, duelAnswerSeconds(servedMs, nowMs, DUEL_QUESTION_SECONDS), DUEL_QUESTION_SECONDS);

  const inserted = await db.from('attempt_answers').insert({
    id: args.answerId,
    attempt_id: attempt.id,
    user_id: attempt.user_id,
    question_id: question.id,
    question_version: question.version,
    response: parsed ? args.response : null,
    correct: outcome.correct,
    score: outcome.score,
    points_awarded: points,
    points_max: DUEL_MAX_POINTS,
    grading_status: 'graded',
    time_spent_ms: Math.max(0, nowMs - servedMs),
    answered_at: args.now.toISOString(),
  });
  if (inserted.error) {
    if (inserted.error.code === '23505') return { kind: 'existing' };
    throw inserted.error;
  }

  if (!outcome.correct) {
    const cause = suggestMistakeCause({
      type: question.type,
      stem: question.stem,
      payload: payloadOf(question),
      response: parsed,
      confidence: null,
      timeSeconds: Math.max(0, nowMs - servedMs) / 1000,
      medianTimeSeconds: null,
    });
    const open = await db
      .from('mistakes')
      .select('id')
      .eq('user_id', attempt.user_id)
      .eq('question_id', question.id)
      .is('resolved_at', null)
      .is('deleted_at', null)
      .maybeSingle();
    if (open.error) throw open.error;
    if (!open.data) {
      const mistake = await db.from('mistakes').insert({
        id: deps.newId(),
        user_id: attempt.user_id,
        question_id: question.id,
        attempt_answer_id: args.answerId,
        subject_id: question.subject_id,
        node_id: question.node_id,
        cause,
        suggested_cause: cause,
        cause_source: 'suggested',
        next_retry_at: args.now.toISOString().slice(0, 10),
      });
      if (mistake.error) throw mistake.error;
    }
  }

  const evidence = await db.from('mastery_evidence').upsert(
    {
      id: deps.newId(),
      user_id: attempt.user_id,
      node_id: question.node_id,
      subject_id: question.subject_id,
      source: 'duel',
      outcome: outcome.correct ? 1 : 0,
      weight: 0.75,
      ref_type: 'attempt_answer',
      ref_id: args.answerId,
      occurred_at: args.now.toISOString(),
    },
    { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true },
  );
  if (evidence.error) throw evidence.error;
  await deps.enqueue(
    'mastery.recompute',
    { user_id: attempt.user_id, node_ids: [question.node_id] },
    { singletonKey: attempt.user_id, singletonSeconds: 60 },
  );
  return { kind: 'recorded', correct: outcome.correct, points, timeout: args.timeout };
}

/**
 * When both players have answered every question, closes the duel: scores, winner, attempts submitted,
 * result pushes. The update is conditional on status, so two concurrent last answers finish it once.
 */
export async function finalizeIfComplete(deps: P2Deps, duel: DuelRow, quiz: QuizRow, now: Date): Promise<boolean> {
  const db = deps.db;
  if (duel.status !== 'waiting_opponent' || !duel.challenger_attempt_id || !duel.opponent_attempt_id) return false;
  const total = quiz.question_ids.length;
  const { data, error } = await db
    .from('attempt_answers')
    .select('attempt_id, correct, points_awarded')
    .in('attempt_id', [duel.challenger_attempt_id, duel.opponent_attempt_id]);
  if (error) throw error;
  const rows = data ?? [];
  const tally = (attemptId: string) => {
    const mine = rows.filter((r) => r.attempt_id === attemptId);
    return {
      answered: mine.length,
      points: mine.reduce((s, r) => s + Number(r.points_awarded ?? 0), 0),
      correct: mine.filter((r) => r.correct === true).length,
    };
  };
  const c = tally(duel.challenger_attempt_id);
  const o = tally(duel.opponent_attempt_id);
  if (c.answered < total || o.answered < total) return false;

  const outcome = duelOutcome(duel, c.points, o.points);
  const finished = await db
    .from('duels')
    .update({ status: 'finished', challenger_score: c.points, opponent_score: o.points, winner_id: outcome.winner_id })
    .eq('id', duel.id)
    .eq('status', 'waiting_opponent')
    .select('id');
  if (finished.error) throw finished.error;
  if (!finished.data || finished.data.length === 0) return false;

  for (
    const [attemptId, tallied] of [
      [duel.challenger_attempt_id, c],
      [duel.opponent_attempt_id, o],
    ] as const
  ) {
    const upd = await db
      .from('quiz_attempts')
      .update({ status: 'submitted', finished_at: now.toISOString(), score: total > 0 ? tallied.correct / total : 0 })
      .eq('id', attemptId);
    if (upd.error) throw upd.error;
  }
  const payload = (result: 'win' | 'lose' | 'tie') => ({
    class_group_id: duel.class_group_id,
    duel_id: duel.id,
    result,
  });
  const forOpponent = outcome.result_for_challenger === 'win'
    ? 'lose'
    : outcome.result_for_challenger === 'lose'
    ? 'win'
    : 'tie';
  await pushTo(deps, duel.challenger_id, 'duel_finished', payload(outcome.result_for_challenger));
  await pushTo(deps, duel.opponent_id, 'duel_finished', payload(forOpponent));
  return true;
}

/** Schedules the expiry job at expires_at (SOC-02.10). Singleton per duel. */
export async function scheduleDuelExpiry(deps: P2Deps, duel: { id: string; expires_at: string }): Promise<void> {
  await scheduleAt(deps, 'duel.expire', { duel_id: duel.id }, new Date(duel.expires_at), `duel-expire:${duel.id}`);
}

export interface DuelContext {
  attempt: AttemptRow;
  quiz: QuizRow;
  duel: DuelRow;
}

/**
 * The caller's duel attempt, with its quiz and duel. Another user's attempt, a non-duel quiz, or a
 * quiz without a duel is 404. A finished, declined or expired duel is 409 duel_not_open.
 */
export async function loadDuelContext(
  db: SupabaseClient,
  attemptId: string,
  userId: string,
  now: Date,
): Promise<DuelContext> {
  const attempt = await loadOwnAttempt(db, attemptId, userId);
  const quiz = await loadQuiz(db, attempt.quiz_id);
  if (!quiz || quiz.kind !== 'duel') throw new ApiFailure('not_found');
  const duel = await duelForQuiz(db, quiz.id);
  if (!duel || (duel.challenger_id !== userId && duel.opponent_id !== userId)) throw new ApiFailure('not_found');
  if (attempt.status !== 'in_progress' || !isDuelOpen(duel, now)) throw new ApiFailure('duel_not_open');
  return { attempt, quiz, duel };
}
