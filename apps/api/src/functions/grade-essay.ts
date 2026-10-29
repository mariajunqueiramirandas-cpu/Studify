// grade-essay (PRA-07, CAM-03, ENM-05; api §4.5). School answers (questões dissertativas) are graded here,
// synchronously, by grade.essayQuestion against the question's rubric, or a rubric the grader builds from the
// material for a user-provided question (PRA-07.3). The score is recomputed in code from the criteria, so the
// model cannot raise it by itself. ENEM redações are graded by the worker (essay.grade) and announced by push.
import {
  ApiFailure,
  ENEM_ESSAYS_PER_WEEK,
  GradeEssayReqSchema,
  HEAVY_EDIT_RATIO,
  estimateHandwrittenLines,
  redacaoLineCheck,
  transcriptionLineCount,
  parseQuestionPayload,
  parseTranscriptionMarkers,
  type GradeEssayRes,
  type SchoolEssayFeedback,
} from '@studify/shared';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { loadSubject, canReadSubject, requireSubject, type SubjectRow } from '../shared/access.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, inBackground, type Deps } from '../shared/deps.ts';
import { createAiJob, activeJobCount } from '../shared/jobs.ts';
import { recordMistake } from '../shared/mistakes.ts';
import { captureImages } from '../shared-p3/capture.ts';
import { recordStandaloneAnswer } from '../shared-p3/standalone.ts';

interface EssayRow {
  id: string;
  user_id: string;
  kind: 'enem_redacao' | 'school_answer';
  theme_id: string | null;
  input_mode: 'typed' | 'photo';
  question_id: string | null;
  prompt: { question_text?: string; max_points?: number; subject_id?: string | null; node_id?: string | null; theme?: string } | null;
  text: string;
  image_paths: string[];
  capture_id: string | null;
  transcription_original: string | null;
  edited_ratio: number | null;
  status: 'draft' | 'grading' | 'graded' | 'failed';
  feedback: SchoolEssayFeedback | null;
  parent_essay_id: string | null;
  deleted_at: string | null;
  updated_at: string;
}

// A redação marked as being graded with no grading running (a restart interrupted it), or marked this long ago,
// lost its grading: it can be graded again.
const STUCK_GRADING_MS = 15 * 60_000;

async function gradingRuns(deps: Parameters<typeof activeJobCount>[0], userId: string, essay: EssayRow): Promise<boolean> {
  if (essay.status !== 'grading' || Date.now() - Date.parse(essay.updated_at) >= STUCK_GRADING_MS) return false;
  const { count, error } = await deps.db
    .from('ai_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('type', 'essay.grade')
    .in('status', ['queued', 'running', 'waiting_batch', 'waiting_budget']);
  if (error) throw error;
  return (count ?? 0) > 0;
}

interface GradeOut {
  built_rubric: boolean;
  criteria: Array<{ id: string; criterion: string; points_max: number; points: number; verdict: 'full' | 'partial' | 'none'; justification: string }>;
  strengths: string[];
  missing: Array<{ point: string; source_pages: Array<{ doc: string; page_start: number; page_end: number }> }>;
  model_answer: string;
  misconceptions: string[];
  suggested_cause: 'didnt_know' | 'confused' | 'careless' | 'misread' | null;
  grader_confidence: 'low' | 'medium' | 'high';
  feedback: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The score from the criteria (PRA-07.5): with a stored rubric every criterion must be one of the rubric's and
 * is capped at its points; a built rubric is rescaled to the maximum. Returns null for an unusable grade.
 */
export function scoreEssay(out: GradeOut, rubric: Array<{ id: string; criterion: string; points: number }> | null, maxPoints: number) {
  if (rubric) {
    const byId = new Map(rubric.map((r) => [r.id, r]));
    if (out.criteria.some((c) => !byId.has(c.id)) || new Set(out.criteria.map((c) => c.id)).size !== rubric.length) return null;
    const criteria = out.criteria.map((c) => {
      const max = byId.get(c.id)!.points;
      return { ...c, points_max: max, points: Math.min(max, Math.max(0, c.points)) };
    });
    const points = criteria.reduce((s, c) => s + c.points, 0);
    return { criteria, points: round2(points), score: Math.min(1, points / maxPoints) };
  }
  const builtMax = out.criteria.reduce((s, c) => s + c.points_max, 0);
  if (builtMax <= 0) return null;
  const scale = maxPoints / builtMax;
  const criteria = out.criteria.map((c) => {
    const max = round2(c.points_max * scale);
    return { ...c, points_max: max, points: Math.min(max, round2(Math.max(0, c.points) * scale)) };
  });
  const points = criteria.reduce((s, c) => s + c.points, 0);
  return { criteria, points: round2(points), score: Math.min(1, points / maxPoints) };
}

/** Topic page text labelled by document, as the grader reads it (≤ 40 pages). */
async function topicPages(deps: Deps, nodeId: string | null) {
  if (!nodeId) return { pages: [] as Array<{ doc: string; page: number; text: string }>, labels: {} as Record<string, string> };
  const sources = await deps.db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', nodeId).is('deleted_at', null);
  if (sources.error) throw sources.error;
  const rows = sources.data as Array<{ document_id: string; page_start: number; page_end: number }>;
  const docIds = [...new Set(rows.map((r) => r.document_id))];
  const labels: Record<string, string> = {};
  docIds.forEach((id, i) => (labels[`D${i + 1}`] = id));
  const pages: Array<{ doc: string; page: number; text: string }> = [];
  for (const [label, docId] of Object.entries(labels)) {
    const res = await deps.db.from('document_pages').select('page_number, text').eq('document_id', docId).order('page_number').limit(200);
    if (res.error) throw res.error;
    for (const p of res.data as Array<{ page_number: number; text: string | null }>) {
      if (!p.text || !rows.some((r) => r.document_id === docId && p.page_number >= r.page_start && p.page_number <= r.page_end)) continue;
      if (pages.length >= 40) break;
      pages.push({ doc: label, page: p.page_number, text: p.text.slice(0, 3500) });
    }
  }
  return { pages, labels };
}

export const handler = defineFunction<{ essay_id: string }>({
  name: 'grade-essay',
  // Structured result computed directly inside SSE (ADR 0010).
  streamResult: true,
  mutating: true,
  aiCall: true,
  input: GradeEssayReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const res = await db.from('essays').select('*').eq('id', input.essay_id).maybeSingle();
    if (res.error) throw res.error;
    const essay = res.data as EssayRow | null;
    if (!essay || essay.user_id !== userId || essay.deleted_at) throw new ApiFailure('not_found');
    if (!essay.text.trim()) throw new ApiFailure('invalid_request', { message: 'Escreva ou confirme a resposta antes de corrigir.' });

    if (essay.kind === 'enem_redacao') {
      if (await gradingRuns(deps, userId, essay)) throw new ApiFailure('already_exists', { message: 'Sua redação já está sendo corrigida.' });
      if (!essay.theme_id && !essay.prompt?.theme) throw new ApiFailure('invalid_request', { message: 'Escolha o tema da redação antes de corrigir.' });
      // ENM-05.2: up to 7 lines is "texto insuficiente", decided here without a model call.
      const check = redacaoLineCheck(essay.text, essay.input_mode);
      const lineFields = {
        line_count: essay.input_mode === 'photo' ? transcriptionLineCount(essay.text) : null,
        est_handwritten_lines: essay.input_mode === 'typed' ? estimateHandwrittenLines(essay.text) : null,
      };
      if (check.tooShort) {
        const zero = await db
          .from('essays')
          .update({ status: 'graded', total: 0, is_zero: true, zero_reasons: ['texto_insuficiente'], competencias: null, ...lineFields })
          .eq('id', essay.id);
        if (zero.error) throw zero.error;
        return ctx.json({ mode: 'zero', essay: { id: essay.id, status: 'graded', total: 0, zero_reasons: ['texto_insuficiente'], lines: check.lines } } satisfies GradeEssayRes);
      }
      // ENM-05.9: weekly correction budget (graded or grading in the last 7 days).
      const since = new Date(ctx.now.getTime() - 7 * 86_400_000).toISOString();
      const recent = await db.from('essays').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('kind', 'enem_redacao').in('status', ['grading', 'graded']).gte('updated_at', since).is('deleted_at', null);
      if (recent.error) throw recent.error;
      if ((recent.count ?? 0) >= ENEM_ESSAYS_PER_WEEK) {
        throw new ApiFailure('rate_limited', { message: `Você já usou as ${ENEM_ESSAYS_PER_WEEK} correções de redação desta semana. Na próxima semana tem mais!` });
      }
      if ((await activeJobCount(deps, userId)) >= 3) throw new ApiFailure('rate_limited', { message: 'Você já tem 3 correções em andamento. Espera uma terminar.' });
      const jobId = await createAiJob(deps, { type: 'essay.grade', userId, stage: 'essay' });
      const marked = await db.from('essays').update({ status: 'grading', ...lineFields }).eq('id', essay.id);
      if (marked.error) throw marked.error;
      await inBackground(deps, 'essay.grade', { essay_id: essay.id, user_id: userId, ai_job_id: jobId }, `essay.grade:${essay.id}`);
      return ctx.json({ mode: 'async', job_id: jobId, eta_s: 90 } satisfies GradeEssayRes, 202);
    }

    if (essay.status === 'graded' && essay.feedback) {
      return ctx.json({ mode: 'sync', essay: { id: essay.id, status: 'graded', feedback: essay.feedback } } satisfies GradeEssayRes);
    }

    // The question: a bank essay_question, or the student's own question (PRA-07.1).
    let stem: string;
    let rubric: Array<{ id: string; criterion: string; points: number }> | null = null;
    let modelAnswer: string | null = null;
    let maxPoints: number;
    let nodeId: string | null = null;
    let subject: SubjectRow | null = null;
    let question: Record<string, unknown> | null = null;
    if (essay.question_id) {
      const q = await db.from('questions').select('id, subject_id, node_id, type, stem, payload, explanation, concept_ids, source_pages, personal_for_user_id, version').eq('id', essay.question_id).maybeSingle();
      if (q.error) throw q.error;
      if (!q.data || (q.data.personal_for_user_id && q.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
      question = q.data as Record<string, unknown>;
      subject = await requireSubject(db, userId, q.data.subject_id as string, 'read');
      stem = q.data.stem as string;
      nodeId = q.data.node_id as string;
      if (q.data.type === 'essay_question' || q.data.type === 'short_answer') {
        const payload = parseQuestionPayload(q.data.type as 'essay_question', q.data.payload);
        rubric = payload.rubric.map((r) => ({ id: r.id, criterion: r.criterion, points: r.points }));
        modelAnswer = payload.model_answer;
        maxPoints = payload.max_points;
      } else {
        maxPoints = 10;
      }
    } else if (essay.prompt?.question_text) {
      stem = essay.prompt.question_text;
      maxPoints = essay.prompt.max_points ?? 10; // PRA-07.4
      nodeId = essay.prompt.node_id ?? null;
      if (essay.prompt.subject_id) {
        const s = await loadSubject(db, essay.prompt.subject_id);
        subject = s && (await canReadSubject(db, userId, s)) ? s : null;
      }
    } else {
      throw new ApiFailure('invalid_request', { message: 'Diga qual é a questão para eu corrigir.' });
    }

    const marked = await db.from('essays').update({ status: 'grading' }).eq('id', essay.id);
    if (marked.error) throw marked.error;
    const { pages, labels } = await topicPages(deps, nodeId);
    const markers = parseTranscriptionMarkers(essay.transcription_original ?? '');
    const heavilyEdited = Number(essay.edited_ratio ?? 0) > HEAVY_EDIT_RATIO;
    const built = getTask('grade.essayQuestion').build({
      question: { stem, rubric, modelAnswer, maxPoints },
      studentAnswer: essay.text,
      pages,
      images: essay.image_paths.length > 0 ? await captureImages(db, essay.image_paths, 2) : [],
      transcription: essay.capture_id ? { heavilyEdited, illegibleSegments: markers.illegible } : null,
      contentLanguage: subject?.content_language ?? 'pt-BR',
      languageSubject: subject?.is_language_subject ?? false,
    });
    let out: GradeOut;
    try {
      const textPages: Record<string, number[]> = {};
      for (const p of pages) (textPages[p.doc] ??= []).push(p.page);
      const result = await callTask(claudeDepsFor(deps), { built, taskId: 'grade.essayQuestion', ctx: budgetCtxFor(subject, userId, 'PRA-07', 'user', { nodeId }), textPages });
      out = unwrapResult(result) as GradeOut;
    } catch (err) {
      await db.from('essays').update({ status: 'failed' }).eq('id', essay.id);
      throw err;
    }
    const scored = scoreEssay(out, rubric, maxPoints);
    if (!scored) {
      await db.from('essays').update({ status: 'failed' }).eq('id', essay.id);
      throw new ApiFailure('ai_unavailable', { message: 'Não consegui corrigir agora. Tenta de novo.' });
    }

    let delta: number | null = null;
    if (essay.parent_essay_id) {
      const parent = await db.from('essays').select('feedback').eq('id', essay.parent_essay_id).maybeSingle();
      const prev = (parent.data?.feedback as SchoolEssayFeedback | null)?.points_awarded;
      if (typeof prev === 'number') delta = round2(scored.points - prev);
    }
    const feedback: SchoolEssayFeedback = {
      points_awarded: scored.points,
      points_max: maxPoints,
      score: scored.score,
      criteria: scored.criteria.map((c) => ({ id: c.id, criterion: c.criterion, points: c.points, max_points: c.points_max, verdict: c.verdict, comment: c.justification })),
      strengths: out.strengths,
      missing: out.missing.map((m) => ({
        text: m.point,
        source_pages: m.source_pages.filter((r) => labels[r.doc]).map((r) => ({ document_id: labels[r.doc]!, page_start: r.page_start, page_end: r.page_end })),
      })),
      model_answer: out.model_answer,
      misconceptions: out.misconceptions,
      suggested_cause: scored.score >= 0.999 ? null : out.suggested_cause,
      grader_confidence: markers.illegible > 2 && out.grader_confidence === 'high' ? 'medium' : out.grader_confidence,
      built_rubric: rubric === null,
      heavily_edited: heavilyEdited,
      illegible_segments: markers.illegible,
      delta_points: delta,
    };
    const saved = await db.from('essays').update({ status: 'graded', feedback }).eq('id', essay.id);
    if (saved.error) throw saved.error;

    // A quiz answer that pointed at this essay gets its score (PRA-01.6 flow).
    const linked = await db.from('attempt_answers').select('id').eq('essay_id', essay.id).eq('user_id', userId).maybeSingle();
    let answerId = (linked.data?.id as string | undefined) ?? null;
    if (answerId) {
      await db
        .from('attempt_answers')
        .update({ score: scored.score, correct: scored.score >= 0.999, grading_status: 'graded', grader_confidence: feedback.grader_confidence, points_awarded: scored.points, points_max: maxPoints, ai_feedback: { criteria: feedback.criteria, summary: out.feedback } })
        .eq('id', answerId);
    }
    // PRA-07.9: below 50% goes to the Caderno de Erros (bank questions only: the entry needs a question).
    if (scored.score < 0.5 && question) {
      answerId ??= await recordStandaloneAnswer(db, deps.newId, {
        userId,
        subjectId: question.subject_id as string,
        questionId: question.id as string,
        questionVersion: (question.version as number | undefined) ?? 1,
        response: { text: essay.text },
        correct: false,
        score: scored.score,
        now: ctx.now,
        title: 'Questão dissertativa',
        inputMode: essay.capture_id ? 'photo' : 'typed',
        essayId: essay.id,
      });
      await recordMistake(db, deps.newId, {
        userId,
        answerId,
        question: { ...question, concept_ids: (question.concept_ids as string[]) ?? [] } as never,
        score: scored.score,
        confidence: null,
        suggestedCause: out.suggested_cause,
        response: { text: essay.text },
        timeSeconds: 0,
        now: ctx.now,
      });
    }
    return ctx.json({ mode: 'sync', essay: { id: essay.id, status: 'graded', feedback } } satisfies GradeEssayRes);
  },
});

export default handler;
