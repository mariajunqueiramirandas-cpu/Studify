// Public surface of the practice grading module (spec 05 §8.4, §8.5, §11). Pure functions only.
// Runs identically on device, in Edge Functions and in the worker. Named exports only: the package
// root re-exports everything, so names must not collide with core, learning or planning.

export {
  McqSinglePayloadSchema,
  MultiSelectPayloadSchema,
  TrueFalsePayloadSchema,
  FillBlankPayloadSchema,
  NumericPayloadSchema,
  MatchingPayloadSchema,
  OrderingPayloadSchema,
  ShortAnswerPayloadSchema,
  EssayQuestionPayloadSchema,
  FindErrorPayloadSchema,
  ProblemPayloadSchema,
  QUESTION_PAYLOAD_SCHEMAS,
  QuestionPayloadSchema,
  parseQuestionPayload,
  McqSingleResponseSchema,
  MultiSelectResponseSchema,
  TrueFalseResponseSchema,
  FillBlankResponseSchema,
  NumericResponseSchema,
  MatchingResponseSchema,
  OrderingResponseSchema,
  TextResponseSchema,
  FindErrorResponseSchema,
  ProblemResponseSchema,
  QUESTION_RESPONSE_SCHEMAS,
  QuestionResponseSchema,
  parseQuestionResponse,
} from './payloads.ts';
export type {
  QuestionPayload,
  QuestionPayloadByType,
  QuestionResponse,
  QuestionResponseByType,
  McqSinglePayload,
  MultiSelectPayload,
  TrueFalsePayload,
  FillBlankPayload,
  NumericPayload,
  MatchingPayload,
  OrderingPayload,
  FindErrorPayload,
  ProblemPayload,
} from './payloads.ts';

export { gradeAnswer, hintCredit, isLocallyGraded, withinTolerance } from './grade.ts';
export type { PracticeGradeResult, PracticeGradeOptions } from './grade.ts';

export { foldAnswer, stripAccents, damerauLevenshtein, maxTypoDistance, matchAcceptedAnswer, parseDecimal } from './text.ts';
export type { AnswerMatch } from './text.ts';

export { suggestMistakeCause, deriveAnswerFacts, hasNegativeQualifier } from './cause.ts';
export type { MistakeCauseInput } from './cause.ts';
