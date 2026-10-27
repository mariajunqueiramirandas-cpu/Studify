// Response shapes for Edge Functions. The shared package exports the Zod schemas of the responses (the
// client validates them); these aliases give the handlers the inferred types.
import type { z } from 'zod';
import type * as S from '@studify/shared';

export type CardsGenerateMoreRes = z.infer<typeof S.CardsGenerateMoreResSchema>;
export type CardDraftRes = z.infer<typeof S.CardDraftResSchema>;
export type QuestionsGenerateMoreRes = z.infer<typeof S.QuestionsGenerateMoreResSchema>;
export type NoteGenerateRes = z.infer<typeof S.NoteGenerateResSchema>;
export type QuizCreateRes = z.infer<typeof S.QuizCreateResSchema>;
export type QuizSubmitRes = z.infer<typeof S.QuizSubmitResSchema>;
export type GradeAnswerRes = z.infer<typeof S.GradeAnswerResSchema>;
export type FlagCreateRes = z.infer<typeof S.FlagCreateResSchema>;
export type ReportCreateRes = z.infer<typeof S.ReportCreateResSchema>;
export type ScopeResolveRes = z.infer<typeof S.ScopeResolveResSchema>;
export type IngestStartRes = z.infer<typeof S.IngestStartResSchema>;
export type IngestRetryRes = z.infer<typeof S.IngestRetryResSchema>;
export type UploadPhotosRes = z.infer<typeof S.UploadPhotosResSchema>;
export type AccountDeleteRes = z.infer<typeof S.AccountDeleteResSchema>;
export type GuardianLinkRes = z.infer<typeof S.GuardianLinkResSchema>;
