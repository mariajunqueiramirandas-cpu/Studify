// grade-answer (PRA-01.6, PRA-07, PRA-08). Immediate feedback for short_answer, essay_question and
// problem (expression). An empty answer scores 0 without calling Claude. The student's text is fenced
// as data by the prompt (untrusted-data fragment); the rubric decides the score.
import { z } from 'zod';
import { ApiFailure, GradeAnswerReqSchema, type QuestionType, parseQuestionPayload } from '@studify/shared';
import type { GradeAnswerRes } from '../shared/responses.ts';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { loadSubject, canReadSubject } from '../shared/access.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { recordMistake } from '../shared/mistakes.ts';

const AI_GRADED: ReadonlySet<string> = new Set(['short_answer', 'essay_question', 'problem']);

export const handler = defineFunction<z.infer<typeof GradeAnswerReqSchema>>({
  name: 'grade-answer',
  // Structured result computed directly inside SSE (ADR 0010).
  streamResult: true,
  mutating: true,
  aiCall: true,
  input: GradeAnswerReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;

    const answer = await db.from('attempt_answers').select('*').eq('id', input.attempt_answer_id).maybeSingle();
    if (answer.error) throw answer.error;
    if (!answer.data) throw new ApiFailure('not_found');
    const attempt = await db.from('quiz_attempts').select('user_id').eq('id', answer.data.attempt_id as string).maybeSingle();
    if (attempt.error) throw attempt.error;
    if (!attempt.data || attempt.data.user_id !== userId) throw new ApiFailure('not_found');

    const question = await db
      .from('questions')
      .select('id, type, payload, stem, node_id, subject_id, explanation, source_pages, concept_ids, source_document_id')
      .eq('id', answer.data.question_id as string)
      .maybeSingle();
    if (question.error) throw question.error;
    if (!question.data) throw new ApiFailure('not_found');
    const type = question.data.type as QuestionType;
    if (!AI_GRADED.has(type)) throw new ApiFailure('invalid_request', { message: 'Essa questão é corrigida na hora, sem IA.' });

    const payload = parseQuestionPayload(type, question.data.payload) as unknown as {
      rubric: Array<{ id: string; criterion: string; points: number }>;
      model_answer: string;
      max_points: number;
    };
    const response = (answer.data.response ?? null) as { text?: string } | null;
    const text = response?.text?.trim() ?? '';
    const subject = await loadSubject(db, question.data.subject_id as string);
    if (!subject || !(await canReadSubject(db, userId, subject))) throw new ApiFailure('not_found');

    if (text.length === 0) {
      const blank: GradeAnswerRes = {
        score: 0,
        points_awarded: 0,
        points_max: payload.max_points,
        grader_confidence: 'high',
        feedback: { criteria: [], summary: 'Sem resposta, então nenhum ponto.' },
      };
      await db.from('attempt_answers').update({ score: 0, correct: false, grading_status: 'graded', grader_confidence: 'high' }).eq('id', input.attempt_answer_id);
      return ctx.json(blank);
    }

    const pages = await studyPages(deps, question.data.node_id as string, question.data.source_document_id as string | null);
    const task = getTask('grade.shortAnswer');
    const built = task.build({
      question: { stem: question.data.stem as string, rubric: payload.rubric, modelAnswer: payload.model_answer, maxPoints: payload.max_points },
      studentAnswer: text,
      pages,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'grade.shortAnswer',
      ctx: budgetCtxFor(subject, userId, 'PRA-01.6', 'user', { nodeId: question.data.node_id as string }),
    });
    const data = unwrapResult(result) as {
      score: number;
      criteria: Array<{ id: string; verdict: 'full' | 'partial' | 'none'; points: number; justification: string }>;
      feedback: string;
      suggested_cause: 'didnt_know' | 'confused' | 'careless' | 'misread';
      grader_confidence: 'low' | 'medium' | 'high';
    };
    const pointsAwarded = Math.round(data.score * payload.max_points * 100) / 100;
    await db
      .from('attempt_answers')
      .update({
        score: data.score,
        correct: data.score >= 1,
        grading_status: 'graded',
        grader_confidence: data.grader_confidence,
        points_awarded: pointsAwarded,
        points_max: payload.max_points,
        ai_feedback: { criteria: data.criteria, summary: data.feedback },
      })
      .eq('id', input.attempt_answer_id);
    await recordMistake(db, deps.newId, {
      userId,
      answerId: input.attempt_answer_id,
      question: {
        id: question.data.id as string,
        node_id: question.data.node_id as string,
        subject_id: question.data.subject_id as string,
        type,
        stem: question.data.stem as string,
        payload: question.data.payload,
        explanation: (question.data.explanation as string | null) ?? null,
        concept_ids: (question.data.concept_ids as string[] | null) ?? [],
        source_pages: question.data.source_pages,
      },
      score: data.score,
      confidence: (answer.data.confidence as 1 | 2 | 3 | 4 | null) ?? null,
      suggestedCause: data.suggested_cause,
      response,
      timeSeconds: Math.round(Number(answer.data.time_spent_ms ?? 0) / 1000),
      now: ctx.now,
    });

    const body: GradeAnswerRes = {
      score: data.score,
      points_awarded: pointsAwarded,
      points_max: payload.max_points,
      grader_confidence: data.grader_confidence,
      feedback: {
        criteria: data.criteria.map((c) => ({ id: c.id, verdict: c.verdict, comment: c.justification })),
        summary: data.feedback,
      },
    };
    return ctx.json(body);
  },
});

/** Topic page text for the grader (ai-pipeline §3.5: "topic page text"). Capped at 60 pages. */
async function studyPages(deps: Deps, nodeId: string, documentId: string | null) {
  const sources = await deps.db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', nodeId).is('deleted_at', null);
  if (sources.error) throw sources.error;
  const rows = sources.data as Array<{ document_id: string; page_start: number; page_end: number }>;
  const docIds = [...new Set([...(documentId ? [documentId] : []), ...rows.map((r) => r.document_id)])];
  if (docIds.length === 0) return [];
  const pages = await deps.db.from('document_pages').select('page_number, text').in('document_id', docIds).order('page_number').limit(60);
  if (pages.error) throw pages.error;
  return (pages.data as Array<{ page_number: number; text: string | null }>)
    .filter((p) => p.text && rows.some((r) => p.page_number >= r.page_start && p.page_number <= r.page_end))
    .map((p) => ({ page: p.page_number, text: p.text as string }));
}

export default handler;
