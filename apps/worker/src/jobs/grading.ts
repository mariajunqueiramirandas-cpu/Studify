// grading.answer (PRA-01.6, PRA-03.6): grades one short-answer or essay answer with grade.shortAnswer.
// The score is recomputed from the stored rubric (lib/grading.ts), so the model cannot raise a grade by
// writing in the answer. Wrong answers create a Caderno entry and a remediation card (PRA-04.1, PRA-02.3).
import { z } from 'zod';
import { evidenceWeight, type EvidenceQuestionType } from '@studify/shared';
import { cardsRemediation, gradeShortAnswer, RemediationCard, ShortAnswerGrade, type RemediationInput, type ShortAnswerInput } from '@studify/prompts';
import { parseQuestionPayload, parseQuestionResponse } from '@studify/shared';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { runPrompt, type AiScope } from '../lib/ai-adapter.ts';
import { IN_CHUNK, JobDataError, chunk, unwrap, unwrapRows } from '../lib/db.ts';
import { createRemediationCard, ensureOpenMistake } from '../lib/mistakes.ts';
import { createsMistake, round2, scoreFromCriteria } from '../lib/grading.ts';
import { safeTimeZone, studyDayFor, DEFAULT_ROLLOVER_HOUR } from '../lib/time.ts';

const GradingPayload = z.object({ attempt_answer_id: z.string().min(1) });

/** Pages of the material cited by a topic, as the grader sees them (text is data, see UNTRUSTED_DATA). */
export async function topicPages(ctx: JobContext, nodeId: string): Promise<Array<{ page: number; text: string }>> {
  const sources = unwrapRows<{ document_id: string; page_start: number; page_end: number }>(
    await ctx.supabase.from('node_sources').select('document_id,page_start,page_end').eq('node_id', nodeId),
    'node_sources',
  );
  const out: Array<{ page: number; text: string }> = [];
  let chars = 0;
  const docIds = [...new Set(sources.map((s) => s.document_id))];
  for (const docId of docIds) {
    const ranges = sources.filter((s) => s.document_id === docId);
    const minPage = Math.min(...ranges.map((r) => r.page_start));
    const maxPage = Math.max(...ranges.map((r) => r.page_end));
    for (const part of chunk(Array.from({ length: maxPage - minPage + 1 }, (_v, i) => minPage + i), IN_CHUNK)) {
      const rows = unwrapRows<{ page_number: number; text: string | null }>(
        await ctx.supabase.from('document_pages').select('page_number,text').eq('document_id', docId).in('page_number', part),
        'document_pages',
      );
      for (const row of rows.sort((a, b) => a.page_number - b.page_number)) {
        if (!row.text || !ranges.some((r) => row.page_number >= r.page_start && row.page_number <= r.page_end)) continue;
        if (chars > 40_000) break;
        out.push({ page: row.page_number, text: row.text.slice(0, 4000) });
        chars += Math.min(row.text.length, 4000);
      }
    }
  }
  return out;
}

export interface GradingOutcome {
  status: 'graded' | 'failed' | 'skipped';
  reason?: string;
  score?: number;
  correct?: boolean;
  mistakeCreated?: boolean;
}

async function markFailed(ctx: JobContext, answerId: string, reason: string): Promise<void> {
  unwrap(
    await ctx.supabase.from('attempt_answers').update({ grading_status: 'failed', ai_feedback: { error: reason } }).eq('id', answerId).eq('grading_status', 'pending'),
    'attempt_answers update',
  );
}

export async function handleGradingAnswer(ctx: JobContext, data: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'PRA-01.6' }): Promise<GradingOutcome> {
  const payload = GradingPayload.parse(data);
  const answer = unwrap(
    await ctx.supabase
      .from('attempt_answers')
      .select('id,user_id,question_id,response,correct,score,grading_status,confidence,answered_at')
      .eq('id', payload.attempt_answer_id)
      .maybeSingle(),
    'attempt_answers',
  ) as {
    id: string;
    user_id: string;
    question_id: string;
    response: { text?: unknown } | null;
    correct: boolean | null;
    score: number | null;
    grading_status: string;
    confidence: number | null;
    answered_at: string;
  } | null;
  if (!answer) return { status: 'skipped', reason: 'not_found' };
  if (answer.grading_status !== 'pending') return { status: 'skipped', reason: 'already_graded' };

  const question = unwrap(
    await ctx.supabase.from('questions').select('id,subject_id,node_id,concept_ids,type,stem,payload,explanation').eq('id', answer.question_id).maybeSingle(),
    'questions',
  ) as { id: string; subject_id: string; node_id: string; concept_ids: string[]; type: string; stem: string; payload: unknown; explanation: string | null } | null;
  if (!question) {
    await markFailed(ctx, answer.id, 'question_missing');
    return { status: 'failed', reason: 'question_missing' };
  }
  if (question.type !== 'short_answer' && question.type !== 'essay_question') return { status: 'skipped', reason: 'not_ai_gradable' };

  const subject = unwrap(
    await ctx.supabase.from('subjects').select('content_language,is_language_subject').eq('id', question.subject_id).maybeSingle(),
    'subjects',
  ) as { content_language: string | null; is_language_subject: boolean } | null;
  const qtype = question.type;
  let parsed: { model_answer: string; rubric: Array<{ id: string; criterion: string; points: number }>; max_points: number };
  try {
    parsed = parseQuestionPayload(qtype, question.payload);
  } catch {
    await markFailed(ctx, answer.id, 'invalid_payload');
    return { status: 'failed', reason: 'invalid_payload' };
  }
  const studentText = typeof answer.response?.text === 'string' ? answer.response.text : '';
  const contentLanguage = subject?.content_language ?? 'pt-BR';
  const languageSubject = subject?.is_language_subject ?? false;
  const maxPoints = parsed.max_points;
  const rubric = parsed.rubric;

  let score = 0;
  let suggestedCause: 'didnt_know' | 'confused' | 'careless' | 'misread' = 'didnt_know';
  let feedback = '';
  let grader: { criteria: unknown; missing: unknown; confidence: string; remediation: { front: string; back: string } | null } = {
    criteria: [],
    missing: [],
    confidence: 'high',
    remediation: null,
  };

  if (studentText.trim().length > 0) {
    const input: ShortAnswerInput = {
      question: {
        stem: question.stem,
        rubric: rubric.map((r) => ({ id: r.id, criterion: r.criterion, points: r.points })),
        modelAnswer: parsed.model_answer,
        maxPoints,
      },
      studentAnswer: studentText,
      pages: await topicPages(ctx, question.node_id),
      contentLanguage,
      languageSubject,
    };
    const outcome = await runPrompt(ctx.ai, {
      task: gradeShortAnswer,
      schema: ShortAnswerGrade,
      input,
      scope: { ...scope, userId: answer.user_id, subjectId: question.subject_id, nodeId: question.node_id, feature: scope.feature },
    });
    if (outcome.result.status !== 'ok') {
      await markFailed(ctx, answer.id, outcome.result.status);
      return { status: 'failed', reason: outcome.result.status };
    }
    const checked = scoreFromCriteria(rubric, outcome.result.data.criteria, maxPoints);
    if (!checked.ok) {
      await markFailed(ctx, answer.id, checked.reason);
      return { status: 'failed', reason: checked.reason };
    }
    score = checked.score;
    suggestedCause = outcome.result.data.suggested_cause;
    feedback = outcome.result.data.feedback;
    grader = {
      criteria: outcome.result.data.criteria,
      missing: outcome.result.data.missing,
      confidence: outcome.result.data.grader_confidence,
      remediation: outcome.result.data.remediation_card,
    };
  } else {
    feedback = 'Resposta em branco.';
  }

  const correct = score >= 0.999;
  const pointsAwarded = round2(score * maxPoints);
  unwrap(
    await ctx.supabase
      .from('attempt_answers')
      .update({
        correct,
        score,
        points_awarded: pointsAwarded,
        points_max: maxPoints,
        grading_status: 'graded',
        grader_confidence: grader.confidence,
        ai_feedback: { feedback, criteria: grader.criteria, missing: grader.missing, suggested_cause: suggestedCause },
      })
      .eq('id', answer.id)
      .eq('grading_status', 'pending'),
    'attempt_answers update',
  );

  let mistakeCreated = false;
  if (createsMistake(score)) {
    const owner = unwrap(await ctx.supabase.from('profiles').select('timezone').eq('id', answer.user_id).maybeSingle(), 'profiles') as { timezone: string | null } | null;
    const today = studyDayFor(ctx.now(), safeTimeZone(owner?.timezone), DEFAULT_ROLLOVER_HOUR);
    let remediationId: string | null = null;
    const shared = unwrap(
      await ctx.supabase.from('subjects').select('owner_class_group_id').eq('id', question.subject_id).maybeSingle(),
      'subjects',
    ) as { owner_class_group_id: string | null } | null;
    const personalFor = shared?.owner_class_group_id ? answer.user_id : null;
    let remediation = grader.remediation;
    if (!remediation && studentText.trim().length > 0) {
      const input: RemediationInput = {
        question: { type: qtype, stem: question.stem, correctAnswer: parsed.model_answer, explanation: question.explanation ?? '' },
        studentAnswer: studentText,
        cause: suggestedCause,
        contentLanguage,
        languageSubject,
      };
      const card = await runPrompt(ctx.ai, {
        task: cardsRemediation,
        schema: RemediationCard,
        input,
        scope: { ...scope, userId: answer.user_id, subjectId: question.subject_id, nodeId: question.node_id, feature: 'PRA-02.3' },
      });
      if (card.result.status === 'ok') remediation = card.result.data;
      else ctx.log.warn({ status: card.result.status }, 'grading.answer: remediation card not created');
    }
    if (remediation) {
      remediationId = await createRemediationCard(ctx, {
        userId: answer.user_id,
        subjectId: question.subject_id,
        nodeId: question.node_id,
        personalFor,
        front: remediation.front,
        back: remediation.back,
      });
    }
    const mistake = await ensureOpenMistake(ctx, {
      userId: answer.user_id,
      questionId: question.id,
      attemptAnswerId: answer.id,
      subjectId: question.subject_id,
      nodeId: question.node_id,
      cause: suggestedCause,
      today,
      remediationCardId: remediationId,
    });
    mistakeCreated = mistake.created;
  }

  // Mastery evidence (learning-engine §5.2): quiz answer, weight from the shared table, idempotent on (ref, node).
  const evidenceNode = question.concept_ids[0] ?? question.node_id;
  const weight = evidenceWeight({
    id: answer.id,
    conceptId: evidenceNode,
    answeredAt: new Date(answer.answered_at),
    questionType: qtype as EvidenceQuestionType,
    source: 'quiz',
    score,
    confidence: answer.confidence === 1 || answer.confidence === 2 || answer.confidence === 3 || answer.confidence === 4 ? answer.confidence : null,
  });
  unwrap(
    await ctx.supabase.from('mastery_evidence').upsert(
      [
        {
          user_id: answer.user_id,
          node_id: evidenceNode,
          subject_id: question.subject_id,
          source: 'quiz_answer',
          outcome: score,
          weight,
          ref_type: 'attempt_answer',
          ref_id: answer.id,
          occurred_at: answer.answered_at,
        },
      ],
      { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true },
    ),
    'mastery_evidence insert',
  );
  await ctx.enqueue('mastery.recompute', { user_id: answer.user_id, node_ids: [evidenceNode] }, {
    singletonKey: `mastery.recompute:${answer.user_id}`,
    startAfter: new Date(ctx.now().getTime() + 60_000),
  });
  return { status: 'graded', score, correct, mistakeCreated };
}

export const jobs: JobDefinition[] = [
  {
    name: 'grading.answer',
    retryLimit: 2,
    handler: async (ctx, data) => {
      await handleGradingAnswer(ctx, data);
    },
  },
];


