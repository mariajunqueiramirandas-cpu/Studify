// Answers given outside a quiz (a saved Câmera Mágica question, CAM-02.10; a photographed essay answer,
// PRA-07.9) still need an attempt_answers row so the Caderno de Erros (mistakes.attempt_answer_id) and the
// mastery evidence have a source. This wraps them in a one-question practice quiz, submitted at once.
import type { Db } from '@studify/db';

export interface StandaloneAnswer {
  userId: string;
  subjectId: string;
  questionId: string;
  questionVersion?: number;
  response: unknown;
  correct: boolean;
  score: number;
  now: Date;
  title: string;
  inputMode?: 'typed' | 'photo';
  essayId?: string | null;
  assisted?: boolean;
  hintsUsed?: number;
  solutionViewed?: boolean;
}

/** Creates quiz → submitted attempt → graded answer; returns the attempt_answers id. */
export async function recordStandaloneAnswer(db: Db, newId: () => string, a: StandaloneAnswer): Promise<string> {
  const quizId = newId();
  const attemptId = newId();
  const answerId = newId();
  const at = a.now.toISOString();
  const quiz = await db.from('quizzes').insert({
    id: quizId,
    owner_id: a.userId,
    subject_id: a.subjectId,
    kind: 'practice',
    mode: 'practice',
    title: a.title,
    question_ids: [a.questionId],
    scope: { subject_id: a.subjectId },
    config: { standalone: true },
  });
  if (quiz.error) throw quiz.error;
  const attempt = await db.from('quiz_attempts').insert({
    id: attemptId,
    user_id: a.userId,
    quiz_id: quizId,
    status: 'submitted',
    started_at: at,
    finished_at: at,
    device_id: 'server',
    score: a.score,
  });
  if (attempt.error) throw attempt.error;
  const answer = await db.from('attempt_answers').insert({
    id: answerId,
    attempt_id: attemptId,
    user_id: a.userId,
    question_id: a.questionId,
    question_version: a.questionVersion ?? 1,
    response: a.response,
    correct: a.correct,
    score: a.score,
    grading_status: 'graded',
    time_spent_ms: 0,
    hints_used: a.hintsUsed ?? 0,
    solution_viewed: a.solutionViewed ?? false,
    assisted: a.assisted ?? false,
    input_mode: a.inputMode ?? 'typed',
    essay_id: a.essayId ?? null,
    answered_at: at,
  });
  if (answer.error) throw answer.error;
  return answerId;
}
