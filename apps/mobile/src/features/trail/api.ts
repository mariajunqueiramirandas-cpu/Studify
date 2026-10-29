// Trilha client (TRL-01; api §4.11): open or resume a subject's path, prepare the next steps' content, answer
// a step. The subject home reads its own trail row directly (RLS: own rows) to show the entry card without
// creating a trail.
import { useQuery } from '@tanstack/react-query';
import type { TrailAnswerReq, TrailAnswerRes, TrailGradeRes, TrailSettleReq, TrailState } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { data as callData } from '../../api/data';
import { callFunction } from '../../api/functions';

export function openTrail(subjectId: string) {
  return callFunction<{ subject_id: string }, TrailState>('trail-open', { subject_id: subjectId }, { idempotencyKey: uuidv7() });
}

export function prepareTrail(trailId: string) {
  return callFunction<{ trail_id: string }, TrailState>('trail-prepare', { trail_id: trailId }, { idempotencyKey: uuidv7() });
}

export function answerStep(body: TrailAnswerReq) {
  return callFunction<TrailAnswerReq, TrailAnswerRes>('trail-answer', body, { idempotencyKey: uuidv7() });
}

/** A question's verdict, as soon as it is recorded. */
export function gradeStep(body: TrailAnswerReq) {
  return callFunction<TrailAnswerReq, TrailGradeRes>('trail-grade', body, { idempotencyKey: uuidv7() });
}

/** What the graded question leaves behind: its explanation, the Caderno entry and the next state. */
export function settleStep(body: TrailSettleReq) {
  return callFunction<TrailSettleReq, TrailAnswerRes>('trail-settle', body, { idempotencyKey: uuidv7() });
}

export interface TrailSummary {
  status: 'active' | 'completed';
  chapterIndex: number;
  chapterCount: number;
}

/** The entry card on the subject home: null until the student opens the Trilha for the first time. */
export function useTrailSummary(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['trail', subjectId],
    enabled: !!subjectId,
    queryFn: async (): Promise<TrailSummary | null> => {
      const data = await callData<{ status: 'active' | 'completed'; chapter_index: number; plan: unknown[] } | null>('trail-data-summary', { subject_id: subjectId });
      return data ? { status: data.status, chapterIndex: data.chapter_index, chapterCount: Array.isArray(data.plan) ? data.plan.length : 0 } : null;
    },
  });
}
