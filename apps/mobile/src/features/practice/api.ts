import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';
import type { MistakeCause, QuestionRow, QuestionType } from './types';

export type QuizKind = 'practice' | 'mock_exam' | 'mistake_retry' | 'predicted_test' | 'boss' | 'feed' | 'duel' | 'battle' | 'enem_simulado';
export type QuizMode = 'practice' | 'exam_conditions' | 'relaxed';

export interface QuizScope {
  exam_id?: string;
  goal_id?: string;
  subject_id?: string;
  node_ids?: string[];
  weak_only?: boolean;
  /** Chefão (MOT-02.4): the unit whose topics the boss mixes. */
  unit_node_id?: string;
}

/** An official ENEM item behind a question (features/enem EnemItemMeta). */
export interface EnemQuestionMeta {
  item_id: string;
  edition_year: number;
  day: number;
  position: number | null;
  annulled: boolean;
  crop_paths: string[];
  alt_text: string | null;
}

export interface Quiz {
  id: string;
  owner_id: string;
  kind: QuizKind;
  mode: QuizMode;
  title: string | null;
  question_ids: string[];
  time_limit_s: number | null;
  scope: QuizScope;
  subject_id: string | null;
  exam_id: string | null;
}

export interface Attempt {
  id: string;
  quiz_id: string;
  status: 'in_progress' | 'submitted' | 'expired' | 'abandoned';
  started_at: string;
  finished_at: string | null;
  score: number | null;
  grade: number | null;
}

export interface AttemptAnswer {
  id: string;
  attempt_id: string;
  question_id: string;
  response: unknown;
  correct: boolean | null;
  score: number | null;
  grading_status: 'graded' | 'pending' | 'failed' | 'self_graded';
  ai_feedback: { criteria?: { id: string; verdict: 'full' | 'partial' | 'none'; comment?: string }[]; summary?: string; sections?: Record<string, string> } | null;
  confidence: number | null;
  time_spent_ms: number;
  points_awarded: number | null;
  points_max: number | null;
}

export interface CreateQuizReq {
  kind: QuizKind;
  scope: QuizScope;
  types?: QuestionType[];
  count: number;
  mode: QuizMode;
  time_limit_s?: number;
}

/** PRA-01/PRA-03: server assembles (and tops up) the quiz; returns the attempt to run. */
export async function createQuiz(req: CreateQuizReq) {
  return callFunction<CreateQuizReq, { quiz_id: string; attempt_id: string; question_ids: string[]; generated: number }>('quiz-create', req, { idempotencyKey: uuidv7() });
}

export function useQuizBundle(quizId: string | undefined) {
  return useQuery({
    queryKey: ['quiz', quizId],
    enabled: !!quizId,
    staleTime: Infinity,
    queryFn: async () => {
      const quiz = await row<Quiz>(supabase.from('quizzes').select('*').eq('id', quizId!).maybeSingle());
      if (!quiz) return null;
      const qs = await rows<QuestionRow>(supabase.from('questions').select('*').in('id', quiz.question_ids));
      const byId = new Map(qs.map((q) => [q.id, q]));
      // Official ENEM items carry their printed crops, edition and position (ENM-02.7).
      const official = quiz.kind === 'enem_simulado' || qs.some((q) => q.origin === 'enem_official');
      const enem = official
        ? await rows<Omit<EnemQuestionMeta, 'item_id' | 'position'> & { id: string; question_id: string; positions: Array<{ position: number }> }>(
            supabase.from('enem_items').select('id,question_id,edition_year,day,positions,annulled,crop_paths,alt_text').in('question_id', quiz.question_ids),
          )
        : [];
      const meta = new Map<string, EnemQuestionMeta>(enem.map((e) => [e.question_id, { item_id: e.id, edition_year: e.edition_year, day: e.day, position: e.positions[0]?.position ?? null, annulled: e.annulled, crop_paths: e.crop_paths, alt_text: e.alt_text }]));
      return { quiz, questions: quiz.question_ids.map((id) => byId.get(id)).filter((q): q is QuestionRow => !!q), enem: meta };
    },
  });
}

export function useAttemptResult(attemptId: string | undefined) {
  return useQuery({
    queryKey: ['attempt', attemptId],
    enabled: !!attemptId,
    queryFn: async () => {
      const attempt = await row<Attempt>(supabase.from('quiz_attempts').select('*').eq('id', attemptId!).maybeSingle());
      const answers = await rows<AttemptAnswer>(supabase.from('attempt_answers').select('*').eq('attempt_id', attemptId!));
      const qs = answers.length ? await rows<QuestionRow>(supabase.from('questions').select('*').in('id', answers.map((a) => a.question_id))) : [];
      return { attempt, answers, questions: new Map(qs.map((q) => [q.id, q])) };
    },
    // Poll while the attempt is still being finalized (sync + quiz-submit) or AI grading is pending; give up after ~5 min.
    refetchInterval: (q) => {
      const d = q.state.data;
      const waiting = !d?.attempt || d.attempt.status === 'in_progress' || d.answers.some((a) => a.grading_status === 'pending');
      return waiting && q.state.dataUpdateCount < 75 ? 4000 : false;
    },
  });
}

/** PRA-01.6 immediate AI grading for short answers in practice mode. */
export async function gradeAnswerRemote(attemptAnswerId: string) {
  return callFunction<{ attempt_answer_id: string }, { score: number; points_awarded: number; points_max: number; grader_confidence: string; feedback: { criteria: { id: string; verdict: string; comment: string }[]; summary: string } }>(
    'grade-answer',
    { attempt_answer_id: attemptAnswerId },
    { idempotencyKey: uuidv7() },
  );
}

export interface MistakeRow {
  id: string;
  user_id: string;
  question_id: string;
  attempt_answer_id: string;
  subject_id: string;
  node_id: string;
  cause: MistakeCause | null;
  suggested_cause: MistakeCause | null;
  cause_source: 'suggested' | 'user';
  user_note: string | null;
  next_retry_at: string;
  retry_step: number;
  success_days: number;
  remediation_card_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function useMistakes(filter: 'open' | 'resolved' | 'all') {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['mistakes', userId, filter],
    enabled: !!userId,
    queryFn: async () => {
      let q = supabase.from('mistakes').select('*').eq('user_id', userId!).is('deleted_at', null).order('created_at', { ascending: false });
      if (filter === 'open') q = q.is('resolved_at', null);
      if (filter === 'resolved') q = q.not('resolved_at', 'is', null);
      const list = await rows<MistakeRow>(q);
      const qs = list.length ? await rows<QuestionRow>(supabase.from('questions').select('*').in('id', [...new Set(list.map((m) => m.question_id))])) : [];
      const byId = new Map(qs.map((x) => [x.id, x]));
      return list.map((m) => ({ ...m, question: byId.get(m.question_id) ?? null }));
    },
  });
}

/** PRA-04 cause / "O que eu aprendi" — LWW fields on the user's own row. */
export async function updateMistake(id: string, patch: Partial<Pick<MistakeRow, 'cause' | 'user_note'>>) {
  const { error } = await supabase
    .from('mistakes')
    .update({ ...patch, ...(patch.cause ? { cause_source: 'user' } : {}) })
    .eq('id', id);
  if (error) throw error;
}

export interface CalibrationRow {
  node_id: string;
  confidence: number;
  n: number;
  n_correct: number;
}

export function useCalibration() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['calibration', userId],
    enabled: !!userId,
    queryFn: () => rows<CalibrationRow>(supabase.from('calibration_stats').select('node_id,confidence,n,n_correct').eq('user_id', userId!)),
  });
}

/** PRA-08.5 "Mostrar meu raciocínio": the first wrong step of the student's working and a nudge. */
export function checkProblemWork(questionId: string, working: string) {
  return callFunction<{ question_id: string; working: string }, { first_wrong_step_index: number | null; what_went_wrong: string; nudge: string }>(
    'problem-check-work',
    { question_id: questionId, working },
    { idempotencyKey: uuidv7() },
  );
}
