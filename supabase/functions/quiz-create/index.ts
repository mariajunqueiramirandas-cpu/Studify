// quiz-create (PRA-01, PRA-03, PRA-04, PRA-09.7). Assembles a quiz from the student's bank:
//  - practice / mistake_retry / boss: adaptive pick (selectAdaptiveQuiz, learning-engine §6.3);
//  - mock_exam: simulado composition (composeSimulado, §6.4), topics weighted equally;
//  - predicted_test: reuses the Prova Provável already generated for the exam (PRA-09.7).
// When the bank is short, one top-up call (questions.more) runs for the topic with the fewest questions.
import { z } from 'zod';
import {
  ApiFailure,
  DEFAULT_TIME_ZONE,
  QuizCreateReqSchema,
  type QuestionType,
  composeSimulado,
  localDateOf,
  selectAdaptiveQuiz,
} from '@studify/shared';
import type { QuizCreateRes } from '../_shared/responses.ts';
import { defineFunction } from '../_shared/http.ts';
import { loadSubject, requireSubject, canReadSubject } from '../_shared/access.ts';
import { generateQuestionsForNode } from '../_shared/questions.ts';
import type { Deps } from '../_shared/deps.ts';

type Req = z.infer<typeof QuizCreateReqSchema>;

interface Candidate {
  id: string;
  node_id: string;
  subject_id: string;
  type: QuestionType;
  difficulty: number | null;
  empirical_difficulty: number | null;
  concept_ids: string[];
  seenBefore: boolean;
  daysSinceCorrect: number | null;
  daysSinceSeen: number | null;
  userCorrectRate: number | null;
  cadernoRetryDue: boolean;
  hasOpenMistake: boolean;
}

/** Days between two civil days (YYYY-MM-DD). */
export function daysBetweenDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

async function resolveScope(deps: Deps, userId: string, req: Req): Promise<{ subjectIds: string[]; nodeIds: string[] | null; goalId: string | null; examId: string | null }> {
  const { db } = deps;
  let subjectIds: string[] = [];
  let nodeIds: string[] | null = req.scope.node_ids ?? null;
  let goalId: string | null = req.scope.goal_id ?? null;
  const examId: string | null = req.scope.exam_id ?? null;

  if (examId) {
    const exam = await db.from('exams').select('id, user_id, goal_id, subject_id').eq('id', examId).is('deleted_at', null).maybeSingle();
    if (exam.error) throw exam.error;
    if (!exam.data || exam.data.user_id !== userId) throw new ApiFailure('not_found');
    goalId = (exam.data.goal_id as string) ?? goalId;
    if (exam.data.subject_id) subjectIds.push(exam.data.subject_id as string);
    if (!nodeIds) {
      const scope = await db.from('exam_scope_nodes').select('node_id').eq('exam_id', examId).eq('confirmed', true);
      if (scope.error) throw scope.error;
      nodeIds = (scope.data as Array<{ node_id: string }>).map((r) => r.node_id);
    }
  }
  if (goalId && subjectIds.length === 0) {
    const goal = await db.from('goals').select('id, user_id').eq('id', goalId).is('deleted_at', null).maybeSingle();
    if (goal.error) throw goal.error;
    if (!goal.data || goal.data.user_id !== userId) throw new ApiFailure('not_found');
    const exams = await db.from('exams').select('subject_id').eq('goal_id', goalId).is('deleted_at', null);
    if (exams.error) throw exams.error;
    subjectIds = (exams.data as Array<{ subject_id: string | null }>).map((e) => e.subject_id).filter((v): v is string => !!v);
  }
  if (req.scope.subject_id) subjectIds.push(req.scope.subject_id);
  if (nodeIds && nodeIds.length > 0 && subjectIds.length === 0) {
    const nodes = await db.from('knowledge_nodes').select('subject_id').in('id', nodeIds).is('deleted_at', null);
    if (nodes.error) throw nodes.error;
    subjectIds = [...new Set((nodes.data as Array<{ subject_id: string }>).map((n) => n.subject_id))];
  }
  subjectIds = [...new Set(subjectIds)];
  if (subjectIds.length === 0) throw new ApiFailure('invalid_request', { message: 'Escolhe uma matéria pra montar o simulado.' });

  // Every subject in scope must be readable by the student (IDOR: invisible subjects are not found).
  for (const id of subjectIds) await requireSubject(deps.db, userId, id, 'read');
  return { subjectIds, nodeIds, goalId, examId };
}

async function loadCandidates(deps: Deps, userId: string, subjectIds: string[], nodeIds: string[] | null, today: string): Promise<Candidate[]> {
  const { db } = deps;
  let query = db
    .from('questions')
    .select('id, node_id, subject_id, type, difficulty, empirical_difficulty, concept_ids')
    .in('subject_id', subjectIds)
    .eq('status', 'active')
    .eq('review_status', 'approved')
    .is('deleted_at', null);
  if (nodeIds && nodeIds.length > 0) query = query.in('node_id', nodeIds);
  const questions = await query;
  if (questions.error) throw questions.error;
  const rows = questions.data as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);

  const answers = await db
    .from('attempt_answers')
    .select('question_id, correct, answered_at')
    .eq('user_id', userId)
    .in('question_id', ids);
  if (answers.error) throw answers.error;
  const mistakes = await db
    .from('mistakes')
    .select('question_id, next_retry_at')
    .eq('user_id', userId)
    .in('question_id', ids)
    .is('resolved_at', null);
  if (mistakes.error) throw mistakes.error;

  const history = new Map<string, { n: number; correct: number; lastCorrect: string | null; lastSeen: string | null }>();
  for (const a of answers.data as Array<{ question_id: string; correct: boolean | null; answered_at: string }>) {
    const h = history.get(a.question_id) ?? { n: 0, correct: 0, lastCorrect: null, lastSeen: null };
    h.n += 1;
    if (a.correct) {
      h.correct += 1;
      const day = a.answered_at.slice(0, 10);
      if (!h.lastCorrect || day > h.lastCorrect) h.lastCorrect = day;
    }
    const seen = a.answered_at.slice(0, 10);
    if (!h.lastSeen || seen > h.lastSeen) h.lastSeen = seen;
    history.set(a.question_id, h);
  }
  const open = new Map<string, string>();
  for (const m of mistakes.data as Array<{ question_id: string; next_retry_at: string | null }>) {
    open.set(m.question_id, m.next_retry_at ?? today);
  }

  return rows.map((r) => {
    const id = r.id as string;
    const h = history.get(id);
    const due = open.get(id);
    return {
      id,
      node_id: r.node_id as string,
      subject_id: r.subject_id as string,
      type: r.type as QuestionType,
      difficulty: (r.difficulty as number | null) ?? null,
      empirical_difficulty: (r.empirical_difficulty as number | null) ?? null,
      concept_ids: (r.concept_ids as string[] | null) ?? [],
      seenBefore: !!h,
      daysSinceCorrect: h?.lastCorrect ? daysBetweenDays(h.lastCorrect, today) : null,
      daysSinceSeen: h?.lastSeen ? daysBetweenDays(h.lastSeen, today) : null,
      userCorrectRate: h ? (h.correct + 1) / (h.n + 2) : null,
      cadernoRetryDue: due !== undefined && due <= today,
      hasOpenMistake: due !== undefined,
    };
  });
}

/** One selection pass over the candidates, shaped for the kind. */
export function selectQuestionIds(kind: Req['kind'], candidates: Candidate[], count: number, seed: string): string[] {
  if (kind === 'mock_exam' || kind === 'predicted_test') {
    const topics = [...new Set(candidates.map((c) => c.node_id))].map((topicId) => ({ topicId, weight: 1 }));
    const result = composeSimulado({
      count,
      topics,
      candidates: candidates.map((c) => ({
        questionId: c.id,
        topicId: c.node_id,
        difficulty: c.difficulty ?? 3,
        daysSinceSeen: c.daysSinceSeen,
      })),
      seed,
    });
    return result.questionIds;
  }
  return selectAdaptiveQuiz(
    candidates.map((c) => ({
      questionId: c.id,
      conceptId: c.concept_ids[0] ?? c.node_id,
      questionType: c.type as never,
      pHat: c.userCorrectRate ?? 1 - (c.empirical_difficulty ?? 0.4),
      seenBefore: c.seenBefore,
      daysSinceCorrect: c.daysSinceCorrect,
      overconfident: false,
      examUrgency: 0,
      cadernoRetryDue: c.cadernoRetryDue,
    })),
    count,
  );
}

export const handler = defineFunction<Req>({
  name: 'quiz-create',
  mutating: true,
  aiCall: true,
  input: QuizCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const today = localDateOf(ctx.now, DEFAULT_TIME_ZONE);
    const scope = await resolveScope(deps, userId, input);

    if (input.kind === 'predicted_test') {
      if (!scope.examId) throw new ApiFailure('invalid_request', { message: 'A Prova Provável precisa de uma prova escolhida.' });
      const existing = await deps.db
        .from('quizzes')
        .select('id, question_ids, subject_id')
        .eq('owner_id', userId)
        .eq('kind', 'predicted_test')
        .eq('exam_id', scope.examId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data) throw new ApiFailure('not_found', { message: 'Essa Prova Provável ainda não está pronta. Gera primeiro.' });
      const attemptId = deps.newId();
      const attempt = await deps.db.from('quiz_attempts').insert({ id: attemptId, user_id: userId, quiz_id: existing.data.id, status: 'in_progress', started_at: ctx.now.toISOString(), device_id: 'server' });
      if (attempt.error) throw attempt.error;
      const body: QuizCreateRes = { quiz_id: existing.data.id as string, attempt_id: attemptId, question_ids: existing.data.question_ids as string[], generated: 0 };
      return ctx.json(body, 201);
    }

    let candidates = await loadCandidates(deps, userId, scope.subjectIds, scope.nodeIds, today);
    if (input.kind === 'mistake_retry') candidates = candidates.filter((c) => c.hasOpenMistake);
    if (input.scope.weak_only) candidates = candidates.filter((c) => c.hasOpenMistake || (c.userCorrectRate ?? 0.5) < 0.6);

    const quizId = deps.newId();
    const seed = `${userId}|${quizId}`;
    let questionIds = selectQuestionIds(input.kind, candidates, input.count, seed);
    let generated = 0;

    // Top-up (PRA-01.4): one generation call for the topic with the fewest candidates, when the bank is short.
    if (questionIds.length < input.count && input.kind !== 'mistake_retry') {
      const perNode = new Map<string, number>();
      for (const c of candidates) perNode.set(c.node_id, (perNode.get(c.node_id) ?? 0) + 1);
      const targets = scope.nodeIds && scope.nodeIds.length > 0 ? scope.nodeIds : [...perNode.keys()];
      const target = [...targets].sort((a, b) => (perNode.get(a) ?? 0) - (perNode.get(b) ?? 0))[0];
      const subjectId = (await deps.db.from('knowledge_nodes').select('subject_id').eq('id', target ?? '').maybeSingle()).data?.subject_id as string | undefined;
      if (target && subjectId) {
        const subject = await loadSubject(deps.db, subjectId);
        if (subject && (await canReadSubject(deps.db, userId, subject))) {
          const added = await generateQuestionsForNode(deps, target, { count: 10, subject, userId });
          generated = added.length;
          if (generated > 0) {
            candidates = await loadCandidates(deps, userId, scope.subjectIds, scope.nodeIds, today);
            questionIds = selectQuestionIds(input.kind, candidates, input.count, seed);
          }
        }
      }
    }

    const quiz = await deps.db.from('quizzes').insert({
      id: quizId,
      owner_id: userId,
      subject_id: scope.subjectIds.length === 1 ? scope.subjectIds[0] : null,
      goal_id: scope.goalId,
      exam_id: scope.examId,
      kind: input.kind,
      mode: input.mode,
      title: input.kind === 'mock_exam' ? 'Simulado' : 'Prática',
      question_ids: questionIds,
      time_limit_s: input.time_limit_s ?? null,
      scope: input.scope,
      config: {},
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    if (quiz.error) throw quiz.error;

    const attemptId = deps.newId();
    const attempt = await deps.db.from('quiz_attempts').insert({
      id: attemptId,
      user_id: userId,
      quiz_id: quizId,
      status: 'in_progress',
      started_at: ctx.now.toISOString(),
      device_id: 'server',
    });
    if (attempt.error) throw attempt.error;

    const body: QuizCreateRes = { quiz_id: quizId, attempt_id: attemptId, question_ids: questionIds, generated };
    return ctx.json(body, 201);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
