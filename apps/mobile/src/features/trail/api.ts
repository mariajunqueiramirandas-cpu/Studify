// Trilha client (TRL-01; api §4.11): open or resume a subject's path, prepare the next steps' content, answer
// a step. The subject home reads its own trail row directly (RLS: own rows) to show the entry card without
// creating a trail.
import { useQuery } from '@tanstack/react-query';
import type { TrailAnswerReq, TrailAnswerRes, TrailState } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { row } from '../common/query';

export function openTrail(subjectId: string) {
  return callFunction<{ subject_id: string }, TrailState>('trail-open', { subject_id: subjectId }, { idempotencyKey: uuidv7() });
}

export function prepareTrail(trailId: string) {
  return callFunction<{ trail_id: string }, TrailState>('trail-prepare', { trail_id: trailId }, { idempotencyKey: uuidv7() });
}

export function answerStep(body: TrailAnswerReq) {
  return callFunction<TrailAnswerReq, TrailAnswerRes>('trail-answer', body, { idempotencyKey: uuidv7() });
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
      const data = await row<{ status: 'active' | 'completed'; chapter_index: number; plan: unknown[] }>(
        supabase.from('trails').select('status, chapter_index, plan').eq('subject_id', subjectId!).maybeSingle(),
      );
      return data ? { status: data.status, chapterIndex: data.chapter_index, chapterCount: Array.isArray(data.plan) ? data.plan.length : 0 } : null;
    },
  });
}
