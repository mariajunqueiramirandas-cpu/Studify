// Question selection and projections for duels and battles (learning-engine §6.7, spec 10 §8.2).
// The server is the only place that sees answer keys: `publicQuestion` and `snapshotQuestion` strip them.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ApiFailure,
  gradeAnswer,
  parseQuestionPayload,
  parseQuestionResponse,
  type QuestionPayload,
  type QuestionResponse,
  type QuestionType,
  selectDuelQuestions,
} from '@studify/shared';

export const AUTO_GRADABLE: readonly QuestionType[] = ['mcq_single', 'true_false'];

export interface QuestionRow {
  id: string;
  subject_id: string;
  node_id: string;
  type: QuestionType;
  stem: string;
  stimulus: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  explanation: string | null;
  difficulty: number | null;
  source_pages: unknown[];
  version: number;
}

const QUESTION_COLUMNS =
  'id, subject_id, node_id, type, stem, stimulus, payload, explanation, difficulty, source_pages, version';

export async function loadQuestions(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, QuestionRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from('questions').select(QUESTION_COLUMNS).in('id', [...ids]).is('deleted_at', null);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id as string, row as unknown as QuestionRow]));
}

export async function loadQuestion(db: SupabaseClient, id: string): Promise<QuestionRow | null> {
  return (await loadQuestions(db, [id])).get(id) ?? null;
}

/** Parsed payload (Zod) for grading. Invalid stored payloads are an internal error, not the student's fault. */
export function payloadOf(q: QuestionRow): QuestionPayload {
  return parseQuestionPayload(q.type, q.payload);
}

/** Correct response in the shared response shape: {choice} for mcq_single, {value} for true_false. */
export function correctResponseOf(q: QuestionRow): unknown {
  const p = payloadOf(q);
  if (q.type === 'mcq_single') return { choice: (p as { correct: string }).correct };
  if (q.type === 'true_false') return { value: (p as { correct: boolean }).correct };
  return null;
}

/**
 * Parses the learner response for `q` (shape per practice/payloads.ts). Throws invalid_request on a
 * shape mismatch so a bad client payload is a 400, never a crash or a silent wrong answer.
 */
export function parseResponse(q: QuestionRow, raw: unknown): QuestionResponse {
  try {
    return parseQuestionResponse(q.type, raw);
  } catch {
    throw new ApiFailure('invalid_request', { message: 'Essa resposta não tem o formato certo. Tenta de novo.' });
  }
}

export interface GradeOutcome {
  correct: boolean;
  score: number;
}

export function gradeQuestion(q: QuestionRow, response: QuestionResponse): GradeOutcome {
  // gradeAnswer is generic over the question type; the payload and response were validated for q.type just above.
  const result = gradeAnswer(q.type, payloadOf(q) as never, response as never);
  return { correct: result.correct === true, score: result.score ?? 0 };
}

/** What a player may see before answering (SOC-02.4, SOC-03.5): no answer key, rationales or explanation. */
export function publicQuestion(q: QuestionRow): Record<string, unknown> {
  const base: Record<string, unknown> = { id: q.id, type: q.type, stem: q.stem, stimulus: q.stimulus ?? null };
  if (q.type === 'mcq_single') {
    const p = q.payload as { options: { id: string; text: string }[] };
    base.payload = { options: p.options.map((o) => ({ id: o.id, text: o.text })) };
  } else if (q.type === 'true_false') {
    const p = q.payload as { statement: string };
    base.payload = { statement: p.statement };
  } else {
    base.payload = null;
  }
  return base;
}

/** Snapshot stored in quiz_shares (SOC-09.2): the same public projection, never answers or page refs. */
export function snapshotQuestion(q: QuestionRow): Record<string, unknown> {
  return publicQuestion(q);
}

export interface PoolInput {
  db: SupabaseClient;
  subjectId: string;
  nodeIds: readonly string[] | null;
  types?: readonly QuestionType[];
}

/**
 * Candidate questions for a duel or battle (learning-engine §6.7): approved, active, not personal,
 * not hidden, auto-gradable. Restricted to `nodeIds` when given, otherwise the whole subject.
 */
export async function candidatePool(input: PoolInput): Promise<{ rows: QuestionRow[]; nodeIds: string[] }> {
  const { db, subjectId } = input;
  const nodesQuery = db.from('knowledge_nodes').select('id').eq('subject_id', subjectId).is('deleted_at', null);
  const { data: nodeRows, error: nodeErr } = await nodesQuery;
  if (nodeErr) throw nodeErr;
  const allNodes = (nodeRows ?? []).map((r) => r.id as string);
  const nodeIds = input.nodeIds ? allNodes.filter((id) => input.nodeIds!.includes(id)) : allNodes;
  if (nodeIds.length === 0) {
    throw new ApiFailure('invalid_request', { message: 'Escolhe pelo menos um tópico dessa matéria.' });
  }

  const types = [...(input.types ?? AUTO_GRADABLE)];
  const { data, error } = await db
    .from('questions')
    .select(QUESTION_COLUMNS)
    .eq('subject_id', subjectId)
    .in('node_id', nodeIds)
    .in('type', types)
    .eq('status', 'active')
    .eq('review_status', 'approved')
    .is('hidden_reason', null)
    .is('personal_for_user_id', null)
    .is('deleted_at', null);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as QuestionRow[], nodeIds };
}

export interface RecentAnswer {
  user_id: string;
  question_id: string;
  answered_at: string;
}

/** Recent answers of the given users (for SOC-02.2 exclusion and daysSinceAnswered). */
export async function recentAnswers(
  db: SupabaseClient,
  userIds: readonly string[],
  sinceIso: string,
): Promise<RecentAnswer[]> {
  const { data, error } = await db
    .from('attempt_answers')
    .select('user_id, question_id, answered_at')
    .in('user_id', [...userIds])
    .gte('answered_at', sinceIso);
  if (error) throw error;
  return (data ?? []) as RecentAnswer[];
}

/** Average mastery of the users on the given topics; 0.5 when nothing is known yet (learning-engine §6.1). */
export async function targetMastery(
  db: SupabaseClient,
  userIds: readonly string[],
  nodeIds: readonly string[],
): Promise<number> {
  const { data, error } = await db.from('mastery').select('mastery').in('user_id', [...userIds]).in('node_id', [
    ...nodeIds,
  ]).is('deleted_at', null);
  if (error) throw error;
  const values = (data ?? []).map((r) => Number(r.mastery)).filter((v) => Number.isFinite(v));
  if (values.length === 0) return 0.5;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface PickInput extends PoolInput {
  seedId: string;
  count: number;
  userIds: readonly string[];
  now: Date;
}

/**
 * Picks `count` questions with selectDuelQuestions (learning-engine §6.7). Throws invalid_request when
 * the pool cannot fill the set (a short duel is never started).
 */
export async function pickQuestions(input: PickInput): Promise<{ questionIds: string[]; topicsUsed: number }> {
  const pool = await candidatePool(input);
  const since = new Date(input.now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const answers = await recentAnswers(input.db, input.userIds, since);
  const nowMs = input.now.getTime();
  const lastAnswered = new Map<string, number>();
  for (const a of answers) {
    const ms = nowMs - new Date(a.answered_at).getTime();
    const prev = lastAnswered.get(a.question_id);
    if (prev === undefined || ms < prev) lastAnswered.set(a.question_id, ms);
  }
  const mastery = await targetMastery(input.db, input.userIds, pool.nodeIds);
  const candidates = pool.rows.map((q) => {
    const ms = lastAnswered.get(q.id);
    return {
      questionId: q.id,
      topicId: q.node_id,
      difficulty: q.difficulty ?? 3,
      daysSinceAnswered: ms === undefined ? null : ms / (24 * 60 * 60 * 1000),
    };
  });
  const topicCount = new Set(candidates.map((c) => c.topicId)).size;
  const chosen = selectDuelQuestions({
    duelId: input.seedId,
    candidates,
    targetMastery: mastery,
    count: input.count,
    topicCount,
  });
  if (chosen.length < input.count) {
    throw new ApiFailure('invalid_request', {
      message: 'Ainda não tem perguntas suficientes pra isso. Tenta outra matéria ou mais tópicos.',
    });
  }
  return { questionIds: chosen, topicsUsed: topicCount };
}
