import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';
import type { MistakeCause, QuestionRow, QuestionType } from './types';

export type QuizKind = 'practice' | 'mock_exam' | 'mistake_retry' | 'predicted_test' | 'boss' | 'feed' | 'duel' | 'battle' | 'enem_simulado' | 'trail';
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
      // Official ENEM items carry their printed crops, edition and position (ENM-02.7); the server reads them.
      const bundle = await data<{
        quiz: Quiz;
        questions: QuestionRow[];
        enem: (Omit<EnemQuestionMeta, 'item_id' | 'position'> & { id: string; question_id: string; positions: { position: number }[] })[];
      } | null>('practice-quiz-bundle', { quiz_id: quizId });
      if (!bundle) return null;
      const { quiz, questions: qs, enem } = bundle;
      const byId = new Map(qs.map((q) => [q.id, q]));
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
      const { attempt, answers, questions: qs } = await data<{ attempt: Attempt | null; answers: AttemptAnswer[]; questions: QuestionRow[] }>('practice-attempt', { attempt_id: attemptId });
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
      const { mistakes: list, questions: qs } = await data<{ mistakes: MistakeRow[]; questions: QuestionRow[] }>('practice-mistakes', { filter });
      const byId = new Map(qs.map((x) => [x.id, x]));
      return list.map((m) => ({ ...m, question: byId.get(m.question_id) ?? null }));
    },
  });
}

/** PRA-04 cause / "O que eu aprendi" — LWW fields on the user's own row. */
export async function updateMistake(id: string, patch: Partial<Pick<MistakeRow, 'cause' | 'user_note'>>) {
  await data('practice-mistake-update', { mistake_id: id, ...patch });
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
    queryFn: () => data<CalibrationRow[]>('practice-calibration'),
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

/** MOT-02.4: whether the student already defeated this unit's boss (later wins are worth less XP). */
export async function bossDefeatedBefore(unitNodeId: string): Promise<boolean> {
  const res = await data<{ defeated: boolean }>('practice-boss-defeated', { unit_node_id: unitNodeId });
  return res.defeated;
}
