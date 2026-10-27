// Edge Function payloads: duels, battles and shared quizzes (api.md §4.7, Phase 2).
import { z } from 'zod';
import { BATTLE_STATUS, QUESTION_TYPE } from '../enums.ts';
import { Uuid7Schema, UuidSchema } from './common.ts';
import { SourcePagesSchema } from '../citations.ts';

// ---------------------------------------------------------------- duels (SOC-02)

export const DuelCreateReqSchema = z.object({
  class_group_id: UuidSchema,
  opponent_id: UuidSchema,
  subject_id: UuidSchema,
  node_ids: z.array(UuidSchema).optional(),
  length: z.union([z.literal(5), z.literal(7), z.literal(10)]),
  rematch_of: UuidSchema.optional(),
});
export type DuelCreateReq = z.infer<typeof DuelCreateReqSchema>;

/** The challenger plays right away with the returned attempt. */
export const DuelCreateResSchema = z.object({
  duel_id: UuidSchema,
  quiz_id: UuidSchema,
  attempt_id: UuidSchema,
});

export const DuelRespondReqSchema = z.object({
  duel_id: UuidSchema,
  accept: z.boolean(), // declined → status `declined`, no penalty (SOC-02.5)
});
export const DuelRespondResSchema = z.object({ attempt_id: UuidSchema.optional() });

export const DuelNextReqSchema = z.object({ attempt_id: UuidSchema });

/** Question as shown during a duel: no answer key, rationale or explanation (api §4.7). */
export const QuestionPublicSchema = z.object({
  id: UuidSchema,
  node_id: UuidSchema.optional(),
  type: z.enum(QUESTION_TYPE),
  stem: z.string(),
  stimulus: z.unknown().optional(),
  texto_base: z.unknown().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const DuelNextResSchema = z.union([
  z.object({
    index: z.int().min(0),
    total: z.int().min(1),
    question: QuestionPublicSchema,
    deadline_at: z.iso.datetime(),
  }),
  z.object({ finished: z.literal(true) }),
]);

export const DuelAnswerReqSchema = z.object({
  attempt_id: UuidSchema,
  question_id: UuidSchema,
  response: z.unknown(),
  answer_id: Uuid7Schema,
});
export type DuelAnswerReq = z.infer<typeof DuelAnswerReqSchema>;

/** Answers after `deadline_at` + 1.5 s grace score 0 (SOC-02.4). */
export const DuelAnswerResSchema = z.object({
  correct: z.boolean(),
  points: z.int().min(0),
  correct_response: z.unknown(),
  explanation: z.string(),
  source_pages: SourcePagesSchema,
});

// ---------------------------------------------------------------- battles (SOC-03)

const battleCreateSchema = z.object({
  action: z.literal('create'),
  class_group_id: UuidSchema,
  subject_id: UuidSchema,
  node_ids: z.array(UuidSchema).optional(),
  count: z.union([z.literal(5), z.literal(10), z.literal(15)]),
  seconds_per_question: z.int().min(5).max(120).optional(),
});

const battleStepSchema = (action: 'start' | 'next' | 'end') =>
  z.object({ action: z.literal(action), battle_id: UuidSchema });

const battleKickSchema = z.object({
  action: z.literal('kick'),
  battle_id: UuidSchema,
  user_id: UuidSchema,
});

/** Host-only except `create` (api §4.7). The host's device sends the action; the server checks it. */
export const BattleControlReqSchema = z.discriminatedUnion('action', [
  battleCreateSchema,
  battleStepSchema('start'),
  battleStepSchema('next'),
  battleStepSchema('end'),
  battleKickSchema,
]);
export type BattleControlReq = z.infer<typeof BattleControlReqSchema>;

export const BattleControlResSchema = z.object({
  battle_id: UuidSchema,
  pin: z.string().regex(/^\d{4}$/).optional(), // 4 digits, unique among live battles (SOC-03.2)
  status: z.enum(BATTLE_STATUS),
});

export const BattleJoinReqSchema = z.object({ pin: z.string().regex(/^\d{4}$/, 'four-digit PIN') });
export const BattleJoinResSchema = z.object({
  battle_id: UuidSchema,
  nickname: z.string().min(1).max(30),
});

export const BattleAnswerReqSchema = z.object({
  battle_id: UuidSchema,
  question_index: z.int().min(0),
  response: z.unknown(),
  answer_id: Uuid7Schema,
});
/** Correctness is revealed on the channel at reveal time, never in this response (SOC-03.7). */
export const BattleAnswerResSchema = z.object({ accepted: z.boolean() });

// ---------------------------------------------------------------- quiz-share (SOC-09)

export const QuizShareReqSchema = z.object({ quiz_id: UuidSchema });
export const QuizShareResSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{22}$/, '22-character share token'),
  url: z.url(),
  expires_at: z.iso.datetime(),
});
