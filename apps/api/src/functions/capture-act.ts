// capture-act (CAM-01…03, api §4.8). What the student does with an analyzed capture:
//  explain        CAM-01.1–01.3  streamed explanation grounded in the matched pages (SSE); "not in your material"
//                                 label when nothing matched. A repeated plain explain replays the stored text.
//  solve          CAM-02.4–02.7  hint ladder (camera.solveLadder, built once and kept server-side: the final
//                                 answer is only sent with the last level) or the full solution (SSE).
//  check_answer   CAM-02.4/02.10 "Tentar responder": deterministic comparison with the ladder's answer; mastery
//                                 evidence on the first attempt; a Caderno entry when the question was saved.
//  add_to_subject CAM-01.5–01.7  the photos become a `photo` document and go through ingestion.
//  save_question  CAM-02.9       the solved question joins the subject's bank (origin photo).
//  grade_answer / grade_essay    CAM-03.4–03.6: the confirmed transcription becomes an essays row for grade-essay.
import {
  ApiFailure,
  CaptureActReqSchema,
  HEAVY_EDIT_RATIO,
  cameraAttemptEvidence,
  editRatio,
  evidenceWeight,
  parseTranscriptionMarkers,
  sameSolveAnswer,
  type CaptureActReq,
  type CaptureActRes,
} from '@studify/shared';
import { getTask, type DocumentMap } from '@studify/prompts';
import { defineFunction, type FnContext } from '../shared/http.ts';
import { loadSubject, canReadSubject, requireNode, requireSubject, type SubjectRow } from '../shared/access.ts';
import { callTask, citationsForStorage, openStream, toTaskCall, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { createAiJob } from '../shared/jobs.ts';
import { hashBody } from '../shared/idempotency.ts';
import { recordMistake } from '../shared/mistakes.ts';
import { pumpStream, stopReasonOf } from '../shared/stream.ts';
import { captureImages, loadOwnCapture, matchedSlices, type CaptureRow } from '../shared-p3/capture.ts';
import { recordStandaloneAnswer } from '../shared-p3/standalone.ts';

interface Ladder {
  question_md: string;
  trivial: boolean;
  quantitative: boolean;
  hints: Array<{ level: number; text_md: string }>;
  final_answer: string;
  answer_format: 'numeric' | 'expression' | 'choice' | 'text';
  why_others_wrong: Array<{ option: string; reason: string }>;
  assumptions: string[];
  uncertain_step: number | null;
  source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
}

/** camera_captures.solver: never selectable by the client (column grant), so the answer stays here. */
interface Solver {
  question_index: number;
  question_text: string;
  quantitative: boolean;
  ladder: Ladder;
  documents: DocumentMap | null;
  revealed: number;
  solution_viewed: boolean;
  attempts: Array<{ answer: string; correct: boolean; at: string; hints_revealed: number }>;
}

const QUANT_SUBJECT = /matem|f[ií]sic|qu[ií]mic|estat|geometr|[áa]lgebra/i;

/** CAM-02.6: code execution for Matemática, Física, Química or a statement with numeric computation. */
function isQuantitative(subject: SubjectRow | null, text: string): boolean {
  if (subject && (subject.enem_area === 'MT' || QUANT_SUBJECT.test(subject.name))) return true;
  const digits = (text.match(/\d+/g) ?? []).length;
  return digits >= 2 && /[=+\-×*/^]|\bcalcule\b|\bdetermine\b/i.test(text);
}

async function captureSubject(deps: Deps, userId: string, capture: CaptureRow): Promise<SubjectRow | null> {
  if (!capture.subject_id) return null;
  const subject = await loadSubject(deps.db, capture.subject_id);
  return subject && (await canReadSubject(deps.db, userId, subject)) ? subject : null;
}

function solveResponse(solver: Solver): CaptureActRes {
  const total = solver.ladder.hints.length;
  const revealed = Math.min(total, solver.revealed);
  const done = revealed >= total || solver.solution_viewed;
  return {
    intent: 'solve',
    hint_level: revealed,
    total_levels: total,
    hints: solver.ladder.hints.slice(0, revealed).map((h) => ({ level: h.level, text_md: h.text_md })),
    ...(done ? { final: { answer: solver.ladder.final_answer, why_others_wrong: solver.ladder.why_others_wrong } } : {}),
    assumptions: solver.ladder.assumptions,
  };
}

/** Builds the ladder once per (capture, question) and keeps it server-side (CAM-02.4). */
async function ensureSolver(deps: Deps, userId: string, capture: CaptureRow, questionIndex: number): Promise<Solver> {
  const existing = capture.solver as Solver | null;
  if (existing && existing.question_index === questionIndex) return existing;
  const question = capture.detected_questions?.[questionIndex];
  const questionText = question?.text_md ?? capture.confirmed_text ?? capture.transcription ?? '';
  if (!questionText.trim()) throw new ApiFailure('invalid_request', { message: 'Não achei a questão nessa foto. Tira outra?' });
  const subject = await captureSubject(deps, userId, capture);
  const quantitative = isQuantitative(subject, questionText);
  const slices = await matchedSlices(deps, capture.node_id);
  const built = getTask('camera.solveLadder').build({
    images: await captureImages(deps.db, capture.image_paths, 2),
    questionText,
    slices,
    quantitative,
    matchedLabel: capture.match?.label ?? null,
    contentLanguage: subject?.content_language ?? 'pt-BR',
    languageSubject: subject?.is_language_subject ?? false,
  });
  const result = await callTask(claudeDepsFor(deps), { built, taskId: 'camera.solveLadder', ctx: budgetCtxFor(subject, userId, 'CAM-02', 'user', { nodeId: capture.node_id }) });
  const ladder = unwrapResult(result) as Ladder;
  return { question_index: questionIndex, question_text: questionText, quantitative, ladder, documents: built.documents ?? null, revealed: 0, solution_viewed: false, attempts: [] };
}

async function saveSolver(deps: Deps, captureId: string, solver: Solver, result: Record<string, unknown>): Promise<void> {
  const res = await deps.db.from('camera_captures').update({ solver, result }).eq('id', captureId);
  if (res.error) throw res.error;
}

function sourcePagesFrom(refs: Ladder['source_pages'], documents: DocumentMap | null) {
  if (!documents) return [];
  return refs
    .filter((r) => documents.labels[r.doc] && (documents.allowedPages[r.doc] ?? []).includes(r.page_start))
    .map((r) => ({ document_id: documents.labels[r.doc]!, page_start: r.page_start, page_end: r.page_end }));
}

async function explain(ctx: FnContext<CaptureActReq>, capture: CaptureRow, focusText: string | null): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  const stored = capture.result as { kind?: string; text?: string; citations?: unknown[]; not_in_material?: boolean } | null;
  if (!focusText && stored?.kind === 'explain' && stored.text) {
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, capture_id: capture.id });
      writer.send('delta', { text: stored.text as string });
      writer.send('done', { stop_reason: 'end_turn', usage_pct_today: await ctx.usagePct(), result: { capture_id: capture.id, not_in_material: stored.not_in_material ?? false, citations: stored.citations ?? [] } });
    });
  }
  const subject = await captureSubject(deps, userId, capture);
  const slices = await matchedSlices(deps, capture.node_id);
  const built = getTask('camera.explain').build({
    images: await captureImages(deps.db, capture.image_paths, 2),
    transcription: capture.transcription ?? '',
    focusText,
    slices,
    matchedLabel: capture.match?.label ?? null,
    contentLanguage: subject?.content_language ?? 'pt-BR',
    languageSubject: subject?.is_language_subject ?? false,
  });
  const session = await openStream(claudeDepsFor(deps), toTaskCall({ built, taskId: 'camera.explain', ctx: budgetCtxFor(subject, userId, 'CAM-01', 'user', { nodeId: capture.node_id }) }));
  return ctx.sse(async (writer) => {
    writer.send('meta', { request_id: ctx.requestId, capture_id: capture.id });
    const { result } = await pumpStream(writer, session);
    const notInMaterial = slices.length === 0;
    const citations = result.status === 'ok' ? citationsForStorage(result.citations) : [];
    if (result.status === 'ok' && !focusText) {
      await deps.db.from('camera_captures').update({ result: { kind: 'explain', text: result.text, citations, not_in_material: notInMaterial } }).eq('id', capture.id);
    }
    writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: await ctx.usagePct(), result: { capture_id: capture.id, not_in_material: notInMaterial, citations } });
  });
}

async function solveFull(ctx: FnContext<CaptureActReq>, capture: CaptureRow, solver: Solver): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  const subject = await captureSubject(deps, userId, capture);
  const stored = capture.result as { solution_md?: string } | null;
  solver.solution_viewed = true;
  solver.revealed = solver.ladder.hints.length;
  const final = { answer: solver.ladder.final_answer, why_others_wrong: solver.ladder.why_others_wrong, uncertain_step: solver.ladder.uncertain_step };
  if (stored?.solution_md) {
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, capture_id: capture.id });
      writer.send('delta', { text: stored.solution_md as string });
      writer.send('done', { stop_reason: 'end_turn', usage_pct_today: await ctx.usagePct(), result: { capture_id: capture.id, final } });
    });
  }
  const slices = await matchedSlices(deps, capture.node_id);
  const built = getTask('camera.solveFull').build({
    images: await captureImages(deps.db, capture.image_paths, 2),
    questionText: solver.question_text,
    slices,
    quantitative: solver.quantitative,
    matchedLabel: capture.match?.label ?? null,
    finalAnswer: solver.ladder.final_answer,
    contentLanguage: subject?.content_language ?? 'pt-BR',
    languageSubject: subject?.is_language_subject ?? false,
  });
  const session = await openStream(claudeDepsFor(deps), toTaskCall({ built, taskId: 'camera.solveFull', ctx: budgetCtxFor(subject, userId, 'CAM-02', 'user', { nodeId: capture.node_id }) }));
  return ctx.sse(async (writer) => {
    writer.send('meta', { request_id: ctx.requestId, capture_id: capture.id });
    const { result } = await pumpStream(writer, session);
    const citations = result.status === 'ok' ? citationsForStorage(result.citations) : [];
    await saveSolver(deps, capture.id, solver, {
      kind: 'solve',
      hint_level: solver.revealed,
      hints: solver.ladder.hints,
      ...(result.status === 'ok' ? { solution_md: result.text, solution_citations: citations } : {}),
      final,
    });
    writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: await ctx.usagePct(), result: { capture_id: capture.id, final, citations } });
  });
}

async function checkAnswer(ctx: FnContext<CaptureActReq>, capture: CaptureRow, answer: string): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  const solver = capture.solver as Solver | null;
  if (!solver) throw new ApiFailure('invalid_request', { message: 'Abra a questão antes de responder.' });
  const correct = sameSolveAnswer(solver.ladder.answer_format, solver.ladder.final_answer, answer);
  const first = solver.attempts.length === 0;
  solver.attempts.push({ answer: answer.slice(0, 200), correct, at: ctx.now.toISOString(), hints_revealed: solver.revealed });
  await saveSolver(deps, capture.id, solver, { ...(capture.result ?? {}), kind: 'solve', last_attempt_correct: correct });

  // CAM-02.10: only the first attempt is evidence; assisted (≥ level 3 or solution seen) correct answers carry no weight.
  const outcome = cameraAttemptEvidence(correct, solver.revealed, solver.solution_viewed);
  if (first && outcome && capture.node_id && capture.subject_id) {
    const weight = evidenceWeight({
      id: capture.id,
      conceptId: capture.node_id,
      answeredAt: ctx.now,
      questionType: 'mcq_single',
      source: 'camera',
      score: outcome.score,
      solutionViewed: outcome.solutionViewed,
    });
    if (weight > 0) {
      await deps.db.from('mastery_evidence').upsert(
        [{ user_id: userId, node_id: capture.node_id, subject_id: capture.subject_id, source: 'quiz_answer', outcome: outcome.score, weight, ref_type: 'camera_capture', ref_id: capture.id, occurred_at: ctx.now.toISOString() }],
        { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true },
      );
      await deps.enqueue('mastery.recompute', { user_id: userId, node_ids: [capture.node_id] }, { singletonKey: `mastery.recompute:${userId}`, startAfterSeconds: 60 });
    }
    // A wrong attempt on a saved question goes to the Caderno de Erros.
    if (!correct && capture.question_id) {
      const question = await deps.db.from('questions').select('id, node_id, subject_id, type, stem, payload, explanation, concept_ids, source_pages').eq('id', capture.question_id).maybeSingle();
      if (question.error) throw question.error;
      if (question.data) {
        const answerId = await recordStandaloneAnswer(deps.db, deps.newId, {
          userId,
          subjectId: question.data.subject_id as string,
          questionId: question.data.id as string,
          response: { answer },
          correct: false,
          score: 0,
          now: ctx.now,
          title: 'Câmera Mágica',
          hintsUsed: solver.revealed,
        });
        await recordMistake(deps.db, deps.newId, {
          userId,
          answerId,
          question: { ...(question.data as Record<string, unknown>), concept_ids: (question.data.concept_ids as string[]) ?? [] } as never,
          score: 0,
          confidence: null,
          response: { answer },
          timeSeconds: 0,
          now: ctx.now,
        });
      }
    }
  }
  const body: CaptureActRes = {
    intent: 'check_answer',
    correct,
    message: correct ? 'Boa! Você acertou 🎉' : 'Ainda não. Quer mais uma dica?',
    hint_level: solver.revealed,
  };
  return ctx.json(body);
}

async function addToSubject(ctx: FnContext<CaptureActReq>, capture: CaptureRow, subjectId: string): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  if (capture.document_id) {
    const job = await deps.db.from('ai_jobs').select('id').eq('document_id', capture.document_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return ctx.json({ intent: 'add_to_subject', document_id: capture.document_id, job_id: (job.data?.id as string) ?? capture.document_id } satisfies CaptureActRes);
  }
  const subject = await requireSubject(deps.db, userId, subjectId, 'upload');
  // CAM-01.7: photos of people never reach a shared subject unblurred.
  if (subject.owner_class_group_id && capture.quality_flags.contains_people === true && !capture.faces_blurred) {
    throw new ApiFailure('forbidden', { message: 'Desfoque os rostos antes de adicionar fotos à matéria da turma.' });
  }
  const documentId = deps.newId();
  const checksum = await hashBody([...capture.image_paths].sort().join('\n'));
  const inserted = await deps.db.from('documents').insert({
    id: documentId,
    subject_id: subject.id,
    uploaded_by: userId,
    title: `Câmera Mágica ${ctx.now.toISOString().slice(0, 10)}`,
    kind: 'photo',
    storage_path: `documents/${subject.id}/${documentId}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 1,
    checksum_sha256: checksum,
    status: 'processing',
  });
  if (inserted.error) {
    if (inserted.error.code === '23505') throw new ApiFailure('duplicate_document', { message: 'Você já adicionou essas páginas.' });
    throw inserted.error;
  }
  const jobId = await createAiJob(deps, { type: 'ingest.photos_to_pdf', userId, subjectId: subject.id, documentId, stage: 'photos' });
  await deps.enqueue('ingest.photos_to_pdf', { subject_id: subject.id, image_paths: capture.image_paths, document_id: documentId, ai_job_id: jobId, user_id: userId }, { retryLimit: 3 });
  const updated = await deps.db.from('camera_captures').update({ saved: true, document_id: documentId, subject_id: subject.id }).eq('id', capture.id);
  if (updated.error) throw updated.error;
  return ctx.json({ intent: 'add_to_subject', document_id: documentId, job_id: jobId } satisfies CaptureActRes, 202);
}

async function saveQuestion(ctx: FnContext<CaptureActReq>, capture: CaptureRow, subjectId?: string, nodeId?: string): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  if (capture.question_id) return ctx.json({ intent: 'save_question', question_id: capture.question_id } satisfies CaptureActRes);
  const solver = capture.solver as Solver | null;
  if (!solver) throw new ApiFailure('invalid_request', { message: 'Resolva a questão antes de salvar.' });
  const targetNode = nodeId ?? capture.node_id;
  if (!targetNode) throw new ApiFailure('invalid_request', { message: 'Escolha o tópico para salvar a questão.' });
  const { node, subject } = await requireNode(deps.db, userId, targetNode);
  if (subjectId && subject.id !== subjectId) throw new ApiFailure('invalid_request');
  const ladder = solver.ladder;
  const hints = ladder.hints.map((h) => h.text_md.slice(0, 200));
  while (hints.length < 3) hints.push(hints[hints.length - 1] ?? 'Releia o enunciado.');
  const isText = ladder.answer_format === 'text';
  const payload = isText
    ? { model_answer: ladder.final_answer, rubric: [{ id: 'r1', criterion: 'Chega à resposta correta', points: 1 }], max_points: 1, key_terms: [] }
    : {
        given: {},
        final_answer: ladder.final_answer,
        answer_format: ladder.answer_format,
        tolerance: null,
        check_expression: null,
        solution_steps: ladder.hints.map((h) => h.text_md),
        hints: hints.slice(0, 3),
      };
  const questionId = deps.newId();
  const inserted = await deps.db.from('questions').insert({
    id: questionId,
    subject_id: subject.id,
    node_id: node.kind === 'concept' ? (node.parent_id as string) : (node.id as string),
    concept_ids: node.kind === 'concept' ? [node.id as string] : [],
    type: isText ? 'short_answer' : 'problem',
    stem: solver.question_text,
    payload,
    explanation: (ladder.hints[ladder.hints.length - 1]?.text_md ?? '').slice(0, 1200),
    bloom_level: 'apply',
    difficulty: ladder.trivial ? 2 : 3,
    has_math: solver.question_text.includes('$'),
    source_pages: sourcePagesFrom(ladder.source_pages, solver.documents),
    origin: 'photo',
    source_capture_id: capture.id,
    // R8: items a member creates inside a Turma subject are private to them.
    personal_for_user_id: subject.owner_class_group_id ? userId : null,
    status: 'active',
  });
  if (inserted.error) throw inserted.error;
  const updated = await deps.db.from('camera_captures').update({ saved: true, question_id: questionId }).eq('id', capture.id);
  if (updated.error) throw updated.error;
  return ctx.json({ intent: 'save_question', question_id: questionId } satisfies CaptureActRes);
}

async function toEssay(ctx: FnContext<CaptureActReq>, capture: CaptureRow, input: Extract<CaptureActReq, { intent: 'grade_answer' | 'grade_essay' }>): Promise<Response> {
  const { deps } = ctx;
  const userId = ctx.user.userId;
  if (!capture.transcription) throw new ApiFailure('invalid_request', { message: 'Leia a foto antes de corrigir.' });
  if (capture.essay_id) {
    const existing = await deps.db.from('essays').select('id, edited_ratio').eq('id', capture.essay_id).maybeSingle();
    if (existing.data) {
      return ctx.json({ intent: input.intent, essay_id: capture.essay_id, next: 'grade-essay', heavily_edited: Number(existing.data.edited_ratio ?? 0) > HEAVY_EDIT_RATIO } satisfies CaptureActRes);
    }
  }
  if (input.question_id) {
    const q = await deps.db.from('questions').select('id, subject_id, personal_for_user_id').eq('id', input.question_id).is('deleted_at', null).maybeSingle();
    if (q.error) throw q.error;
    if (!q.data || (q.data.personal_for_user_id && q.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
    await requireSubject(deps.db, userId, q.data.subject_id as string, 'read');
  }
  if (input.subject_id) await requireSubject(deps.db, userId, input.subject_id, 'read');
  // CAM-03.5: the server measures the edit, the client's number is not trusted.
  const ratio = editRatio(capture.transcription, input.confirmed_text);
  const markers = parseTranscriptionMarkers(capture.transcription);
  const essayId = deps.newId();
  const inserted = await deps.db.from('essays').insert({
    id: essayId,
    user_id: userId,
    kind: input.intent === 'grade_essay' ? 'enem_redacao' : 'school_answer',
    theme_id: input.theme_id ?? null,
    question_id: input.question_id ?? null,
    prompt: input.question_text ? { question_text: input.question_text, max_points: input.max_points ?? 10, subject_id: input.subject_id ?? capture.subject_id ?? null, node_id: capture.node_id } : null,
    text: input.confirmed_text,
    input_mode: 'photo',
    image_paths: capture.image_paths,
    capture_id: capture.id,
    transcription_original: capture.transcription,
    edited_ratio: ratio,
    line_count: input.confirmed_text.split(/\r?\n/).filter((l) => l.trim()).length,
    est_handwritten_lines: (capture.quality_flags.line_count_estimate as number | undefined) ?? null,
    status: 'draft',
  });
  if (inserted.error) throw inserted.error;
  const updated = await deps.db
    .from('camera_captures')
    .update({ saved: true, essay_id: essayId, confirmed_text: input.confirmed_text, edited_ratio: ratio, quality_flags: { ...capture.quality_flags, illegible: markers.illegible } })
    .eq('id', capture.id);
  if (updated.error) throw updated.error;
  return ctx.json({ intent: input.intent, essay_id: essayId, next: 'grade-essay', heavily_edited: ratio > HEAVY_EDIT_RATIO } satisfies CaptureActRes);
}

export const handler = defineFunction<CaptureActReq>({
  name: 'capture-act',
  mutating: true,
  aiCall: true,
  input: CaptureActReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const capture = await loadOwnCapture(deps.db, userId, input.capture_id);
    if (capture.status !== 'ready' && input.intent !== 'add_to_subject') {
      throw new ApiFailure('invalid_request', { message: 'A foto ainda está sendo lida. Espera um pouquinho.' });
    }
    switch (input.intent) {
      case 'explain':
        return explain(ctx, capture, input.focus_text ?? null);
      case 'solve': {
        const solver = await ensureSolver(deps, userId, capture, input.question_index ?? 0);
        if (input.reveal === 'solution') return solveFull(ctx, capture, solver);
        const total = solver.ladder.hints.length;
        solver.revealed = input.reveal === 'hint' ? Math.max(1, solver.revealed) : Math.min(total, solver.revealed + 1);
        const body = solveResponse(solver);
        await saveSolver(deps, capture.id, solver, { kind: 'solve', hint_level: solver.revealed, hints: (body as { hints: unknown }).hints, total_levels: total });
        return ctx.json(body);
      }
      case 'check_answer':
        return checkAnswer(ctx, capture, input.answer);
      case 'add_to_subject':
        return addToSubject(ctx, capture, input.subject_id);
      case 'save_question':
        return saveQuestion(ctx, capture, input.subject_id, input.node_id);
      case 'grade_answer':
      case 'grade_essay':
        return toEssay(ctx, capture, input);
    }
  },
});

export default handler;
