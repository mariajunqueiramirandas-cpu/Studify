// Server-side re-grade of a quiz answer (api §4.5, PRA-01.6–01.8). The same shared grader runs on the device
// for offline quizzes; the server result is authoritative. AI-graded types return status 'pending'.
import {
  gradeAnswer,
  isLocallyGraded,
  parseQuestionPayload,
  parseQuestionResponse,
  type QuestionType,
} from '@studify/shared';

export interface OfflineGrade {
  correct: boolean | null;
  score: number | null;
  status: 'graded' | 'pending' | 'failed';
}

/** Server-side re-grade of one answer (authoritative, api §4.5). AI-graded types wait for grading.answer. */
export function gradeOffline(
  type: QuestionType,
  rawPayload: unknown,
  rawResponse: unknown,
  hintsUsed: number,
  solutionViewed: boolean,
): OfflineGrade {
  let payload: ReturnType<typeof parseQuestionPayload<QuestionType>>;
  try {
    payload = parseQuestionPayload(type, rawPayload);
  } catch {
    return { correct: null, score: null, status: 'failed' };
  }
  if (!(isLocallyGraded as (t: QuestionType, p: unknown) => boolean)(type, payload)) return { correct: null, score: null, status: 'pending' };
  if (rawResponse === null || rawResponse === undefined) return { correct: false, score: 0, status: 'graded' };
  let response: ReturnType<typeof parseQuestionResponse<QuestionType>>;
  try {
    response = parseQuestionResponse(type, rawResponse);
  } catch {
    // A response of the wrong shape scores 0, the same as a blank answer (practice grader contract).
    return { correct: false, score: 0, status: 'graded' };
  }
  // The grader is generic over the question type; the runtime pairing is checked by the parsers above.
  const result = (gradeAnswer as (t: QuestionType, p: unknown, r: unknown, o: unknown) => { correct: boolean | null; score: number | null })(type, payload, response, { hintsUsed, solutionViewed });
  return { correct: result.correct, score: result.score, status: 'graded' };
}

