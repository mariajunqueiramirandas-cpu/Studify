import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';

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
    queryFn: () => rows<TeacherProfile>(supabase.from('teacher_profiles').select('*').eq('subject_id', subjectId!).order('n_tests', { ascending: false })),
  });
}

export function usePredictedQuiz(examId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['exam', examId, 'predicted'],
    enabled: !!examId && !!userId,
    refetchInterval: (q) => (q.state.data ? false : 8000),
    queryFn: () =>
      row<{ id: string; question_ids: string[]; created_at: string }>(
        supabase.from('quizzes').select('id,question_ids,created_at').eq('owner_id', userId!).eq('exam_id', examId!).eq('kind', 'predicted_test').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ),
  });
}

/** PRA-09: async; result is a quizzes row with kind = predicted_test. */
export const generatePredicted = (examId: string, regenerate = false) =>
  callFunction<{ exam_id: string; regenerate: boolean }, { job_id: string }>('prova-provavel-generate', { exam_id: examId, regenerate }, { idempotencyKey: uuidv7() });

/** PRA-09.11 "O que caiu?" — topics that actually fell (optional, skippable; D-16). */
export async function saveExamOutcome(userId: string, examId: string, nodeIds: string[]) {
  if (!nodeIds.length) return;
  const { error } = await supabase.from('exam_outcome_topics').upsert(
    nodeIds.map((node_id) => ({ exam_id: examId, user_id: userId, node_id })),
    { onConflict: 'exam_id,user_id,node_id' },
  );
  if (error) throw error;
}

export interface ScheduleImport {
  id: string;
  status: 'draft' | 'applied' | 'discarded';
  extracted: { subject_name: string; title: string; local_date: string; starts_at?: string | null; content_items?: string[] }[] | null;
}

export function useScheduleImport(id: string | null) {
  return useQuery({
    queryKey: ['scheduleImport', id],
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.extracted ? false : 4000),
    queryFn: () => row<ScheduleImport>(supabase.from('schedule_imports').select('*').eq('id', id!).maybeSingle()),
  });
}

export const startScheduleImport = (documentId: string) =>
  callFunction<{ document_id: string }, { job_id: string; schedule_import_id: string }>('schedule-import', { document_id: documentId }, { idempotencyKey: uuidv7() });
