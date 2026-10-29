// Câmera Mágica client (spec 11; api §4.8): uploads the prepared photos to photos/{user}/{capture}/n.jpg,
// inserts the camera_captures row, and calls capture-analyze / capture-act. Essays made from a photographed
// answer are graded by grade-essay (PRA-07, CAM-03).
import type { CaptureActReq, CaptureActRes, CaptureAnalyzeRes, CaptureIntent, GradeEssayRes, SchoolEssayFeedback } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction, streamFunction } from '../../api/functions';
import { messageFor } from '../../api/messages';
import { t } from '../../i18n';
import { uploadFile } from '../../api/storage';
import { toEventHandler, type StreamHandlers } from '../learn/api';
import type { PreparedPhoto } from './image';

export type { CaptureIntent };

export interface CaptureRow {
  id: string;
  user_id: string;
  intent: CaptureIntent;
  subject_id: string | null;
  node_id: string | null;
  image_paths: string[];
  quality_flags: Record<string, unknown>;
  faces_blurred: boolean;
  content_type: string | null;
  transcription: string | null;
  confirmed_text: string | null;
  detected_questions: Array<{ index: number; label: string; preview: string; complete: boolean; has_figure: boolean }> | null;
  match: { subject_id: string; node_ids: string[]; confidence: number; label: string } | null;
  result: Record<string, unknown> | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error_code: string | null;
  saved: boolean;
  document_id: string | null;
  question_id: string | null;
  essay_id: string | null;
  created_at: string;
}

export type SolveRes = Extract<CaptureActRes, { intent: 'solve' }>;

/** Uploads the photos and creates the capture row (status queued). Returns the capture id. */
export async function createCapture(
  userId: string,
  input: { intent: CaptureIntent; photos: (PreparedPhoto & { blurChecked: boolean })[]; subjectId?: string | null; nodeId?: string | null },
  onProgress?: (pct: number) => void,
): Promise<string> {
  const captureId = uuidv7();
  const paths: string[] = [];
  for (const [i, photo] of input.photos.entries()) {
    const object = `${userId}/${captureId}/${i + 1}.jpg`;
    await uploadFile({
      bucket: 'photos',
      path: object,
      uri: photo.uri,
      contentType: 'image/jpeg',
      onProgress: (pct) => onProgress?.(Math.round(((i + pct / 100) / input.photos.length) * 100)),
    });
    paths.push(`photos/${object}`);
  }
  await data(
    'camera-data-capture-create',
    {
      id: captureId,
      intent: input.intent,
      subject_id: input.subjectId ?? null,
      node_id: input.nodeId ?? null,
      image_paths: paths,
      quality_flags: { device: input.photos.map((p) => p.issues), faces: input.photos.reduce((n, p) => n + p.faces, 0) },
      // True only when the on-device face pass ran on every photo (CAM-00.6, CAM-01.7).
      faces_blurred: input.photos.every((p) => p.blurChecked),
    },
    { idempotencyKey: captureId },
  );
  return captureId;
}

export function useCapture(captureId: string | undefined) {
  return useQuery({
    queryKey: ['capture', captureId],
    enabled: !!captureId,
    queryFn: () => data<CaptureRow | null>('camera-data-capture', { capture_id: captureId }),
  });
}

export function analyzeCapture(captureId: string) {
  return callFunction<{ capture_id: string }, CaptureAnalyzeRes>('capture-analyze', { capture_id: captureId }, { idempotencyKey: uuidv7() });
}

export function captureAct<T extends CaptureActRes>(input: CaptureActReq) {
  return callFunction<CaptureActReq, T>('capture-act', input, { idempotencyKey: uuidv7() });
}

/** CAM-01: streamed explanation; `focusText` explains one paragraph only ("Explica só isso"). */
export function streamCaptureExplain(captureId: string, focusText: string | null, handlers: StreamHandlers) {
  return streamFunction('capture-act', { capture_id: captureId, intent: 'explain', ...(focusText ? { focus_text: focusText } : {}) }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

/** CAM-02.5: the full worked solution (streamed). */
export function streamCaptureSolution(captureId: string, questionIndex: number, handlers: StreamHandlers) {
  return streamFunction('capture-act', { capture_id: captureId, intent: 'solve', question_index: questionIndex, reveal: 'solution' }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

/** Deletes an unsaved capture (the photos follow with the nightly purge, spec 11 §8.4). */
export async function discardCapture(captureId: string) {
  try {
    await data('camera-data-capture-discard', { capture_id: captureId });
  } catch {
    // ignored, as before
  }
}

// ---------------------------------------------------------------- essays (PRA-07, CAM-03)

export interface EssayRow {
  id: string;
  kind: 'enem_redacao' | 'school_answer';
  question_id: string | null;
  prompt: { question_text?: string; max_points?: number; subject_id?: string | null } | null;
  text: string;
  input_mode: 'typed' | 'photo';
  status: 'draft' | 'grading' | 'graded' | 'failed';
  edited_ratio: number | null;
  feedback: SchoolEssayFeedback | Record<string, unknown> | null;
  total: number | null;
  parent_essay_id: string | null;
  created_at: string;
  /** When it was last changed: for an essay being graded, when the grading started. */
  updated_at: string;
}

/** The essay row; refetched every 4 s while it is being graded (ENEM grading runs in the worker). */
export function useEssay(essayId: string | undefined) {
  return useQuery({
    queryKey: ['essay', essayId],
    enabled: !!essayId,
    queryFn: () => data<EssayRow | null>('camera-data-essay', { essay_id: essayId }),
    refetchInterval: (q) => (q.state.data?.status === 'grading' || q.state.data?.status === 'draft' ? 4000 : false),
  });
}

export function gradeEssay(essayId: string) {
  return callFunction<{ essay_id: string }, GradeEssayRes>('grade-essay', { essay_id: essayId }, { idempotencyKey: uuidv7() });
}

/** A grading marked as started this long ago was lost (the server restarted mid-way): it can be sent again. */
export const LOST_GRADING_MS = 15 * 60_000;

/** Why an essay that is not being graded has no grade, in PT-BR, or null when it is graded or being graded. */
export function essayGradeFailure(e: { status: string; updated_at: string }, jobFailed = false): string | null {
  if (e.status === 'failed') return t('error.generation');
  if (e.status === 'draft') return t('essay.not_graded');
  if (e.status === 'grading' && (jobFailed || Date.now() - Date.parse(e.updated_at) > LOST_GRADING_MS)) return t('wait.interrupted');
  return null;
}

/**
 * "Tentar de novo" on a result screen: the call's own wait and its failure (in PT-BR) until the essay row catches
 * up, and the grading job when the redação is graded in the background.
 */
export function useRegrade(essayId: string | undefined, refetch: () => Promise<unknown>) {
  const [run, setRun] = useState<{ startedAt: number; error: string | null } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const start = () => {
    if (!essayId) return;
    const startedAt = Date.now();
    setRun({ startedAt, error: null });
    gradeEssay(essayId).then(
      async (res) => {
        if (res.mode === 'async') setJobId(res.job_id);
        await refetch();
        setRun(null);
      },
      (err: unknown) => {
        setRun({ startedAt, error: messageFor(err, t('error.generation')) });
        void refetch();
      },
    );
  };
  return { run, jobId, start };
}

/**
 * PRA-07.1 "Tenho uma questão da professora", typed: the essays row carries the question in `prompt`; a new
 * version of an earlier answer points at it (PRA-07.8) so the result shows the difference in points.
 */
export async function createTypedEssay(
  _userId: string,
  input: { text: string; questionId?: string | null; questionText?: string | null; maxPoints?: number | null; subjectId?: string | null; parentEssayId?: string | null },
): Promise<string> {
  const id = uuidv7();
  // The server stores the question in `prompt` ({question_text, max_points (10 by default), subject_id}).
  await data(
    'camera-data-essay-create',
    {
      id,
      text: input.text,
      question_id: input.questionId ?? null,
      question_text: input.questionText ?? null,
      max_points: input.maxPoints ?? null,
      subject_id: input.subjectId ?? null,
      parent_essay_id: input.parentEssayId ?? null,
    },
    { idempotencyKey: id },
  );
  return id;
}
