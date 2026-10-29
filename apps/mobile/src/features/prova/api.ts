import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';

export interface TeacherProfile {
  id: string;
  subject_id: string;
  teacher_key: string | null;
  teacher_display: string | null;
  n_tests: number;
  confidence: 'low' | 'mid' | 'high';
  profile: {
    structure?: { n_questions?: number; type_mix?: Record<string, number>; points?: string };
    hot_topics?: { node_id?: string; title: string; weight: number }[];
    patterns?: string[];
  };
}

export function useTeacherProfiles(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject', subjectId, 'teachers'],
    enabled: !!subjectId,
    queryFn: () => data<TeacherProfile[]>('prova-teacher-profiles', { subject_id: subjectId }),
  });
}

/** The exam's Prova Provável quiz; read again every few seconds only while one is being generated (`waiting`). */
export function usePredictedQuiz(examId: string | undefined, waiting = false) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['exam', examId, 'predicted'],
    enabled: !!examId && !!userId,
    refetchInterval: (q) => (waiting && !q.state.data ? 4000 : false),
    queryFn: () => data<{ id: string; question_ids: string[]; created_at: string } | null>('prova-predicted-quiz', { exam_id: examId }),
  });
}

/** PRA-09: async; result is a quizzes row with kind = predicted_test. */
export const generatePredicted = (examId: string, regenerate = false) =>
  callFunction<{ exam_id: string; regenerate: boolean }, { job_id: string }>('prova-provavel-generate', { exam_id: examId, regenerate }, { idempotencyKey: uuidv7() });

/** PRA-09.11 "O que caiu?" — topics that actually fell (optional, skippable; D-16). */
export async function saveExamOutcome(_userId: string, examId: string, nodeIds: string[]) {
  if (!nodeIds.length) return;
  await data('prova-exam-outcome-save', { exam_id: examId, node_ids: nodeIds });
}

export interface ScheduleImport {
  id: string;
  status: 'draft' | 'applied' | 'discarded';
  extracted: { subject_name: string; title: string; local_date: string; starts_at?: string | null; content_items?: string[] }[] | null;
}

/** The import row; read again every few seconds only while its job is still reading the photo (`waiting`). */
export function useScheduleImport(id: string | null, waiting = false) {
  return useQuery({
    queryKey: ['scheduleImport', id],
    enabled: !!id,
    // `extracted` starts as [] (truthy): the job, not the row, says when reading is over.
    refetchInterval: waiting ? 4000 : false,
    queryFn: () => data<ScheduleImport | null>('prova-schedule-import', { schedule_import_id: id }),
  });
}

export const startScheduleImport = (documentId: string) =>
  callFunction<{ document_id: string }, { job_id: string; schedule_import_id: string }>('schedule-import', { document_id: documentId }, { idempotencyKey: uuidv7() });
