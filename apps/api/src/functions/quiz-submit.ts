// quiz-submit (PRA-01.6, PRA-02, PRA-03, PRA-04, PRA-05). The authoritative scoring of an attempt:
//  - every answer is graded on the server with the shared grader (the same code the device runs offline);
//  - unanswered questions score 0; AI-graded answers stay pending and grading.answer is queued (PRA-03.6);
//  - wrong answers create Caderno entries and remediation cards (PRA-02, PRA-04), via recordMistake;
//  - each graded answer writes mastery_evidence (R13), idempotent on (ref_type, ref_id, node_id).
import { z } from 'zod';
import {
  ApiFailure,
  QuizSubmitReqSchema,
  type QuestionType,
  evidenceWeight,
  simuladoGrade,
  type EvidenceQuestionType,
} from '@studify/shared';
import type { QuizSubmitRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import { gradeOffline } from '../shared/grading.ts';
import { recordMistake } from '../shared/mistakes.ts';

type Req = z.infer<typeof QuizSubmitReqSchema>;

interface Graded {
  answerId: string;
  questionId: string;
  correct: boolean | null;
  score: number | null;
  status: 'graded' | 'pending' | 'failed';
  answeredAt: string;
}

export const handler = defineFunction<Req>({
  name: 'quiz-submit',
  mutating: true,
  input: QuizSubmitReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;

    const attempt = await db.from('quiz_attempts').select('id, user_id, quiz_id, status').eq('id', input.attempt_id).maybeSingle();
    if (attempt.error) throw attempt.error;
    if (!attempt.data || attempt.data.user_id !== userId) throw new ApiFailure('not_found');
    if (attempt.data.status !== 'in_progress') throw new ApiFailure('already_exists', { message: 'Esse simulado já foi entregue.' });

    const quiz = await db.from('quizzes').select('id, question_ids, goal_id').eq('id', attempt.data.quiz_id as string).maybeSingle();
    if (quiz.error) throw quiz.error;
    if (!quiz.data) throw new ApiFailure('not_found');
    const questionIds = quiz.data.question_ids as string[];

    const questions = await db
      .from('questions')
      .select('id, type, payload, stem, node_id, subject_id, explanation, source_pages, concept_ids')
      .in('id', questionIds);
    if (questions.error) throw questions.error;
    const byId = new Map((questions.data as Array<Record<string, unknown>>).map((q) => [q.id as string, q]));

    const existing = await db.from('attempt_answers').select('id, question_id').eq('attempt_id', input.attempt_id);
    if (existing.error) throw existing.error;
    const rowIdByQuestion = new Map((existing.data as Array<{ id: string; question_id: string }>).map((r) => [r.question_id, r.id]));

    // The answers sent now, keyed by question. Unanswered questions get a blank row (score 0).
    const sent = new Map(input.answers.filter((a) => questionIds.includes(a.question_id)).map((a) => [a.question_id, a]));
    const graded: Graded[] = [];
    const rows: Array<{ id: string; exists: boolean; row: Record<string, unknown> }> = [];
    const detail = new Map<string, { type: QuestionType; response: unknown; confidence: 1 | 2 | 3 | 4 | null; time: number; hints: number }>();

    for (const questionId of questionIds) {
      const q = byId.get(questionId);
      if (!q) continue;
      const answer = sent.get(questionId);
      const type = q.type as QuestionType;
      const response = answer?.response ?? null;
      const grading = gradeOffline(type, q.payload, response, answer?.hints_used ?? 0, answer?.solution_viewed ?? false);
      const id = rowIdByQuestion.get(questionId) ?? answer?.id ?? deps.newId();
      const answeredAt = ctx.now.toISOString();
      rows.push({
        id,
        exists: rowIdByQuestion.has(questionId),
        row: {
          attempt_id: input.attempt_id,
          user_id: userId,
          question_id: questionId,
          question_version: 1,
          response,
          correct: grading.correct,
          score: grading.score,
          grading_status: grading.status === 'pending' ? 'pending' : grading.status === 'failed' ? 'failed' : 'graded',
          confidence: answer?.confidence ?? null,
          time_spent_ms: answer?.time_spent_ms ?? 0,
          hints_used: answer?.hints_used ?? 0,
          solution_viewed: answer?.solution_viewed ?? false,
          marked_for_review: answer?.marked_for_review ?? false,
          input_mode: answer?.input_mode ?? 'typed',
          essay_id: answer?.essay_id ?? null,
          answered_at: answer ? input.finished_at : answeredAt,
        },
      });
      graded.push({ answerId: id, questionId, correct: grading.correct, score: grading.score, status: grading.status, answeredAt });
      detail.set(id, {
        type,
        response,
        confidence: (answer?.confidence ?? null) as 1 | 2 | 3 | 4 | null,
        time: Math.round((answer?.time_spent_ms ?? 0) / 1000),
        hints: answer?.hints_used ?? 0,
      });
    }

    for (const { id, exists, row } of rows) {
      if (exists) {
        const updated = await db.from('attempt_answers').update(row).eq('id', id);
        if (updated.error) throw updated.error;
      } else {
        const inserted = await db.from('attempt_answers').insert({ id, ...row });
        if (inserted.error) throw inserted.error;
      }
    }

    // Caderno and remediation (PRA-02, PRA-04): only for answers that were graded now.
    const mistakesCreated: string[] = [];
    const cardsCreated: string[] = [];
    for (const g of graded) {
      if (g.status !== 'graded' || g.score === null) continue;
      const q = byId.get(g.questionId);
      if (!q) continue;
      const d = detail.get(g.answerId);
      const outcome = await recordMistake(db, deps.newId, {
        userId,
        answerId: g.answerId,
        question: {
          id: g.questionId,
          node_id: q.node_id as string,
          subject_id: q.subject_id as string,
          type: q.type as QuestionType,
          stem: q.stem as string,
          payload: q.payload,
          explanation: (q.explanation as string | null) ?? null,
          concept_ids: (q.concept_ids as string[] | null) ?? [],
          source_pages: q.source_pages,
        },
        score: g.score,
        confidence: d?.confidence ?? null,
        response: d?.response,
        timeSeconds: d?.time ?? 0,
        now: ctx.now,
      });
      if (outcome.mistakeId) mistakesCreated.push(outcome.mistakeId);
      if (outcome.cardId) cardsCreated.push(outcome.cardId);
    }

    // Mastery evidence (R13, learning-engine §5): one row per graded answer, idempotent per answer and node.
    const evidence: Record<string, unknown>[] = [];
    for (const g of graded) {
      if (g.status !== 'graded' || g.score === null) continue;
      const q = byId.get(g.questionId);
      if (!q) continue;
      const conceptIds = (q.concept_ids as string[] | null) ?? [];
      const nodeId = conceptIds[0] ?? (q.node_id as string);
      const d = detail.get(g.answerId);
      evidence.push({
        user_id: userId,
        node_id: nodeId,
        subject_id: q.subject_id,
        source: 'quiz_answer',
        outcome: g.score,
        weight: evidenceWeight({
          id: g.answerId,
          conceptId: nodeId,
          answeredAt: new Date(g.answeredAt),
          questionType: q.type as QuestionType as EvidenceQuestionType,
          source: 'quiz',
          score: g.score,
          confidence: d?.confidence ?? null,
          hintsUsed: d?.hints ?? 0,
        }),
        ref_type: 'attempt_answer',
        ref_id: g.answerId,
        occurred_at: g.answeredAt,
      });
    }
    if (evidence.length > 0) {
      const written = await db.from('mastery_evidence').upsert(evidence, { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true });
      if (written.error) throw written.error;
    }

    // Attempt totals: score on the 0–1 scale over all questions; grade on the 0–10 scale for goals (spec 05 §8.10).
    const scored = graded.filter((g) => g.score !== null);
    const total = questionIds.length;
    const sum = scored.reduce((acc, g) => acc + (g.score ?? 0), 0);
    const score = total > 0 ? sum / total : 0;
    const grade = quiz.data.goal_id ? simuladoGrade(sum, total, 10) : null;
    const pending = graded.filter((g) => g.status === 'pending');
    const finished = await db
      .from('quiz_attempts')
      .update({ status: 'submitted', finished_at: input.finished_at, score, grade })
      .eq('id', input.attempt_id);
    if (finished.error) throw finished.error;

    for (const g of pending) {
      await deps.enqueue('grading.answer', { attempt_answer_id: g.answerId }, { singletonKey: g.answerId, retryLimit: 2 });
    }

    const body: QuizSubmitRes = {
      attempt: { id: input.attempt_id, status: 'submitted', score, grade },
      answers: graded.map((g) => ({
        id: g.answerId,
        correct: g.correct,
        score: g.score,
        grading_status: g.status === 'pending' ? 'pending' : g.status === 'failed' ? 'failed' : 'graded',
      })),
      mistakes_created: mistakesCreated,
      cards_created: cardsCreated,
      pending_ai_grading: pending.length,
    };
    return ctx.json(body);
  },
});

export default handler;
