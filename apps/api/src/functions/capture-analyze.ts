// capture-analyze (CAM-01…03, spec 11 §7.1, §7.3, §8.5). Called after the photos are uploaded to
// photos/{user}/{capture}/… and the camera_captures row exists. Explain/solve/add: Step A (camera.understand)
// classifies and transcribes, Step B matches the photo to the student's course. Grading intents get the
// faithful transcription instead (CAM-03.2): the student reviews it before anything is graded (CAM-03.4).
// A photo that is not study content, or that the model refuses, is deleted at once (spec 11 §8.4).
import { ApiFailure, CaptureAnalyzeReqSchema, maxCapturePages, parseTranscriptionMarkers, type CaptureAnalyzeReq, type CaptureAnalyzeRes } from '@studify/shared';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { callTask } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { captureImages, deleteCapturePhotos, loadOwnCapture, matchCapture, readableSubjects, type CaptureRow } from '../shared-p3/capture.ts';

type ModelIssue = 'blur' | 'glare' | 'cutoff' | 'dark' | 'handwriting' | 'other';
type ApiIssue = CaptureAnalyzeRes['quality']['issues'][number];

const ISSUE_MAP: Record<ModelIssue, ApiIssue | null> = {
  blur: 'blur',
  glare: 'glare',
  cutoff: 'partial',
  dark: 'dark',
  handwriting: 'handwriting',
  other: null,
};

/** Stored analysis → response, so a repeated call costs nothing. */
function storedResponse(c: CaptureRow): CaptureAnalyzeRes {
  const issues = ((c.quality_flags.model as ApiIssue[] | undefined) ?? []).filter(Boolean);
  return {
    content_type: (c.content_type ?? 'other') as CaptureAnalyzeRes['content_type'],
    quality: { ok: issues.length === 0, issues },
    transcription: c.transcription ?? '',
    detected_questions: (c.detected_questions ?? []).map((q) => ({ index: q.index, label: q.label, preview: q.preview, complete: q.complete, has_figure: q.has_figure })),
    match: c.match,
    key_concepts: (c.quality_flags.key_concepts as string[] | undefined) ?? [],
  };
}

export const handler = defineFunction<CaptureAnalyzeReq>({
  name: 'capture-analyze',
  mutating: true,
  aiCall: true,
  input: CaptureAnalyzeReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const capture = await loadOwnCapture(db, userId, input.capture_id);
    if (capture.status === 'ready' && capture.content_type) return ctx.json(storedResponse(capture));
    if (capture.image_paths.length > maxCapturePages(capture.intent)) {
      throw new ApiFailure('invalid_request', { message: 'Fotos demais para essa ação. Divida em mais de uma captura.' });
    }
    await db.from('camera_captures').update({ status: 'processing' }).eq('id', capture.id);

    const fail = async (code: string, message: string): Promise<never> => {
      await deleteCapturePhotos(deps.storage, capture.image_paths);
      await db.from('camera_captures').update({ status: 'failed', error_code: code, deleted_at: ctx.now.toISOString() }).eq('id', capture.id);
      throw new ApiFailure('photo_unreadable', { message, details: { reason: code } });
    };

    // CAM-03: faithful transcription for grading. The question or theme is context only.
    if (capture.intent === 'grade_answer' || capture.intent === 'grade_essay') {
      const images = await captureImages(deps.storage, capture.image_paths, 20);
      const built = getTask('camera.transcribe').build({
        images,
        context: capture.intent === 'grade_essay' ? { kind: 'enem_redacao', theme: null } : { kind: 'school_answer', questionText: null },
      });
      const result = await callTask(claudeDepsFor(deps), { built, taskId: 'camera.transcribe', ctx: budgetCtxFor(null, userId, 'CAM-03', 'user') });
      if (result.status === 'refused') return fail('ai_refused', 'Não consegui analisar essa imagem.');
      if (result.status !== 'ok') throw new ApiFailure('ai_unavailable', { message: 'Não consegui ler a foto agora. Tenta de novo.' });
      const data = result.data as { lines: Array<{ n: number; text: string }>; uncertain: unknown[]; illegible_count: number; line_count_estimate: number; title_present: boolean };
      const transcription = data.lines.map((l) => l.text).join('\n');
      const markers = parseTranscriptionMarkers(transcription);
      const issues: ApiIssue[] = markers.illegible > 0 || markers.uncertain.length > 3 ? ['handwriting'] : [];
      const update = {
        status: 'ready',
        content_type: 'essay',
        transcription,
        quality_flags: { ...capture.quality_flags, model: issues, line_count_estimate: data.line_count_estimate, illegible: markers.illegible, title_present: data.title_present },
        detected_questions: [],
      };
      const saved = await db.from('camera_captures').update(update).eq('id', capture.id);
      if (saved.error) throw saved.error;
      const body: CaptureAnalyzeRes = {
        content_type: 'essay',
        quality: { ok: issues.length === 0, issues },
        transcription,
        detected_questions: [],
        match: null,
        key_concepts: [],
      };
      return ctx.json(body);
    }

    // Step A (camera.understand): one page for explain/solve (two when a question continues), all for add_to_subject.
    const subjects = await readableSubjects(db, userId);
    const keyed = subjects.map((s, i) => ({ key: `S${i + 1}`, name: s.name, enemArea: s.enem_area ?? null, id: s.id }));
    const images = await captureImages(deps.storage, capture.image_paths, capture.intent === 'add_to_subject' ? 4 : 2);
    const built = getTask('camera.understand').build({ images, intent: capture.intent, subjects: keyed.map(({ id: _id, ...rest }) => rest) });
    const feature = capture.intent === 'solve' ? 'CAM-02' : 'CAM-01';
    const result = await callTask(claudeDepsFor(deps), { built, taskId: 'camera.understand', ctx: budgetCtxFor(null, userId, feature, 'user') });
    if (result.status === 'refused') return fail('ai_refused', 'Não consegui analisar essa imagem.');
    if (result.status !== 'ok') throw new ApiFailure('ai_unavailable', { message: 'Não consegui ler a foto agora. Tenta de novo.' });
    const a = result.data as {
      content_type: CaptureAnalyzeRes['content_type'];
      language: string;
      is_study_content: boolean;
      contains_people: boolean;
      transcription_md: string;
      key_concepts: string[];
      subject_guess: { subject_key: string | null; confidence: number };
      detected_questions: Array<{ label: string; preview: string; text_md: string; complete: boolean; has_figure: boolean }>;
      quality_issues: Array<{ type: ModelIssue; region_hint: string }>;
    };
    if (!a.is_study_content) return fail('not_study_content', 'Não achei conteúdo de estudo nessa foto.');

    // Step B: course match. A preset subject (opened from a subject screen) restricts the search.
    const preset = capture.subject_id ? subjects.find((s) => s.id === capture.subject_id) ?? null : null;
    const guessed = keyed.find((k) => k.key === a.subject_guess.subject_key);
    const guess = preset ?? (guessed ? subjects.find((s) => s.id === guessed.id) ?? null : null);
    const match = await matchCapture(deps, userId, {
      keyConcepts: a.key_concepts,
      transcription: a.transcription_md,
      subjects,
      guess,
      guessConfidence: preset ? 1 : a.subject_guess.confidence,
    });

    const issues = [...new Set(a.quality_issues.map((q) => ISSUE_MAP[q.type]).filter((v): v is ApiIssue => v !== null))];
    if (capture.intent === 'solve' && a.detected_questions.length > 1) issues.push('multiple_questions');
    const detected = a.detected_questions.map((q, index) => ({ index, ...q }));
    const matchJson = match ? { subject_id: match.subject.id, node_ids: [match.nodeId], confidence: match.confidence, label: match.label } : null;
    const saved = await db
      .from('camera_captures')
      .update({
        status: 'ready',
        content_type: a.content_type,
        language: a.language,
        transcription: a.transcription_md,
        detected_questions: detected,
        quality_flags: { ...capture.quality_flags, model: issues, key_concepts: a.key_concepts, contains_people: a.contains_people },
        match: matchJson,
        subject_id: match?.subject.id ?? capture.subject_id ?? guess?.id ?? null,
        node_id: match?.nodeId ?? null,
      })
      .eq('id', capture.id);
    if (saved.error) throw saved.error;

    const body: CaptureAnalyzeRes = {
      content_type: a.content_type,
      quality: { ok: issues.length === 0, issues },
      transcription: a.transcription_md,
      detected_questions: detected.map((q) => ({ index: q.index, label: q.label, preview: q.preview, complete: q.complete, has_figure: q.has_figure })),
      match: matchJson,
      key_concepts: a.key_concepts,
    };
    return ctx.json(body);
  },
});

export default handler;
