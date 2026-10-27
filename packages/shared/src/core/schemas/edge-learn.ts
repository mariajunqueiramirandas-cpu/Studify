// Edge Function payloads: learn, remember, practice, tutor, flags, goals and planning
// (api.md §4.3–4.6). Streaming endpoints (SSE) are described in sse.ts.
import { z } from 'zod';
import {
  CONFIDENCE_LEVEL,
  EXPLANATION_STYLE,
  EXPLANATION_TARGET,
  FLAG_REASON,
  INPUT_MODE,
  ITEM_TYPE,
  PLAN_TRIGGER,
  QUESTION_TYPE,
  QUIZ_MODE,
  REPORT_REASON,
  SCOPE_ITEM_STATUS,
  TUTOR_MODE,
} from '../enums.ts';
import { IsoInstantSchema, LocalDateSchema, Uuid7Schema, UuidSchema } from './common.ts';
import { SourcePagesSchema } from '../citations.ts';
import { QuizScopeSchema, TutorScopeSchema } from './jsonb.ts';

/** TUT-04.3 / api §4.4: a client message is capped at 4,000 characters. */
export const TUTOR_MESSAGE_MAX_CHARS = 4000;

// ---------------------------------------------------------------- note-generate (LRN-01)

export const NoteGenerateReqSchema = z.object({
  node_id: UuidSchema,
  depth: z.enum(['tldr', 'study', 'deep']),
  regenerate: z.boolean().optional(),
});
export type NoteGenerateReq = z.infer<typeof NoteGenerateReqSchema>;

/** Non-streaming response (tldr/study). Deep notes stream instead. */
export const NoteGenerateResSchema = z.object({
  note_id: UuidSchema,
  status: z.enum(['pending', 'generating', 'ready']),
});

// ---------------------------------------------------------------- explain (LRN-03)

export const ExplainReqSchema = z.object({
  target_type: z.enum(EXPLANATION_TARGET),
  target_id: UuidSchema,
  paragraph_index: z.int().min(0).optional(),
  style: z.enum(EXPLANATION_STYLE),
  force_new: z.boolean().optional(), // "Tentar de novo" → personal explanation
});
export type ExplainReq = z.infer<typeof ExplainReqSchema>;

// ---------------------------------------------------------------- cards and questions generation (MEM-01, PRA-01)

export const CardsGenerateMoreReqSchema = z.object({ node_id: UuidSchema });
export const CardsGenerateMoreResSchema = z.object({
  card_ids: z.array(UuidSchema).max(10), // deduplicated against existing fronts
});

export const CardDraftReqSchema = z.object({
  subject_id: UuidSchema,
  node_id: UuidSchema.optional(),
  selection: z.string().min(1),
  source: z.enum(['note', 'pdf']),
  document_id: UuidSchema.optional(),
  page: z.int().min(1).optional(),
});
export type CardDraftReq = z.infer<typeof CardDraftReqSchema>;

/** Draft only: the app inserts the card after the student edits it. */
export const CardDraftResSchema = z.object({
  front: z.string(),
  back: z.string(),
  type: z.enum(['basic', 'cloze']),
  source_pages: SourcePagesSchema,
});

export const QuestionsGenerateMoreReqSchema = z.object({
  node_id: UuidSchema,
  count: z.int().min(1).max(20).optional(), // default 10; ENEM style defaults to 5
  enem_style: z.boolean().optional(),
});
export const QuestionsGenerateMoreResSchema = z.object({ question_ids: z.array(UuidSchema) });

// ---------------------------------------------------------------- tutor-chat (TUT-01…06)

export const TutorChatReqSchema = z
  .object({
    thread_id: UuidSchema.optional(), // omitted → new thread with `scope`
    scope: TutorScopeSchema.optional(),
    mode: z.enum(TUTOR_MODE),
    message: z.string().min(1).max(TUTOR_MESSAGE_MAX_CHARS),
    client_message_id: Uuid7Schema,
    voice: z.boolean().optional(), // TUT-06: text came from on-device STT
    allow_general_answer: z.boolean().optional(), // TUT-04.3 one-off opt-in
  })
  .refine((r) => r.thread_id !== undefined || r.scope !== undefined, {
    message: 'thread_id or scope is required',
  });
export type TutorChatReq = z.infer<typeof TutorChatReqSchema>;

// ---------------------------------------------------------------- quiz-create and quiz-submit (PRA-01…04)

export const QuizCreateKindSchema = z.enum(['practice', 'mock_exam', 'mistake_retry', 'predicted_test', 'boss']);

export const QuizCreateReqSchema = z.object({
  kind: QuizCreateKindSchema,
  scope: QuizScopeSchema,
  types: z.array(z.enum(QUESTION_TYPE)).optional(),
  count: z.int().min(5).max(90),
  mode: z.enum(QUIZ_MODE),
  time_limit_s: z.int().min(1).optional(),
});
export type QuizCreateReq = z.infer<typeof QuizCreateReqSchema>;

export const QuizCreateResSchema = z.object({
  quiz_id: UuidSchema,
  attempt_id: UuidSchema,
  question_ids: z.array(UuidSchema),
  generated: z.int().min(0),
});

export const AttemptAnswerInputSchema = z.object({
  id: Uuid7Schema,
  question_id: UuidSchema,
  response: z.unknown(), // null = blank
  confidence: z.int().min(1).max(4).optional(), // PRA-05: 1 Chutando … 4 Certeza
  time_spent_ms: z.int().min(0),
  hints_used: z.int().min(0).optional(),
  solution_viewed: z.boolean().optional(),
  marked_for_review: z.boolean().optional(),
  input_mode: z.enum(INPUT_MODE).optional(),
  essay_id: UuidSchema.optional(),
});
export type AttemptAnswerInput = z.infer<typeof AttemptAnswerInputSchema>;

export const QuizSubmitReqSchema = z.object({
  attempt_id: UuidSchema,
  answers: z.array(AttemptAnswerInputSchema),
  finished_at: IsoInstantSchema,
});
export type QuizSubmitReq = z.infer<typeof QuizSubmitReqSchema>;

export const QuizSubmitResSchema = z.object({
  attempt: z.object({
    id: UuidSchema,
    status: z.literal('submitted'),
    score: z.number().min(0).max(1).nullable(), // score real 0–1
    grade: z.number().nullable(), // on the goal's grading scale
    area_results: z.unknown().optional(), // ENEM TRI estimate (Phase 4)
  }),
  answers: z.array(
    z.object({
      id: Uuid7Schema,
      correct: z.boolean().nullable(),
      score: z.number().min(0).max(1).nullable(),
      grading_status: z.enum(['graded', 'pending', 'failed']),
    }),
  ),
  mistakes_created: z.array(UuidSchema),
  cards_created: z.array(UuidSchema), // PRA-02 auto-card
  pending_ai_grading: z.int().min(0), // results arrive via Realtime or a re-fetch
});

// ---------------------------------------------------------------- grade-answer (PRA-01.6, PRA-08)

export const GradeAnswerReqSchema = z.object({ attempt_answer_id: UuidSchema });

export const GradeFeedbackSchema = z.object({
  criteria: z.array(
    z.object({
      id: z.string().min(1),
      verdict: z.enum(['full', 'partial', 'none']),
      comment: z.string(),
    }),
  ),
  summary: z.string(),
});

export const GradeAnswerResSchema = z.object({
  score: z.number().min(0).max(1),
  points_awarded: z.number().min(0),
  points_max: z.number().min(0),
  grader_confidence: z.enum(CONFIDENCE_LEVEL),
  feedback: GradeFeedbackSchema,
});

// ---------------------------------------------------------------- flags and reports (TRU-02, SP-09)

export const FlagCreateReqSchema = z.object({
  item_type: z.enum(ITEM_TYPE),
  item_id: UuidSchema,
  reason: z.enum(FLAG_REASON),
  comment: z.string().max(500).optional(),
});
export type FlagCreateReq = z.infer<typeof FlagCreateReqSchema>;

export const FlagCreateResSchema = z.object({
  flag_id: UuidSchema,
  status: z.literal('open'),
  hidden_for_you: z.boolean(),
});

export const ReportCreateReqSchema = z.object({
  reported_id: UuidSchema.optional(),
  class_group_id: UuidSchema.optional(),
  reason: z.enum(REPORT_REASON),
  context_type: z.string().min(1).optional(), // e.g. nickname, battle, peer_question, document
  context_id: UuidSchema.optional(),
  comment: z.string().max(500).optional(),
});
export type ReportCreateReq = z.infer<typeof ReportCreateReqSchema>;
export const ReportCreateResSchema = z.object({ report_id: UuidSchema });

// ---------------------------------------------------------------- scope-resolve (GOL-03)

export const ScopeResolveReqSchema = z
  .object({
    exam_id: UuidSchema,
    items: z.array(z.string().min(1)).optional(), // typed list
    text: z.string().min(1).optional(), // pasted text
    document_id: UuidSchema.optional(), // photo or PDF of the content list
  })
  .refine((r) => r.items !== undefined || r.text !== undefined || r.document_id !== undefined, {
    message: 'items, text or document_id is required',
  });
export type ScopeResolveReq = z.infer<typeof ScopeResolveReqSchema>;

export const ScopeResolveResSchema = z.object({
  items: z.array(
    z.object({
      id: UuidSchema,
      raw_text: z.string(),
      status: z.enum(SCOPE_ITEM_STATUS),
      nodes: z.array(z.object({ node_id: UuidSchema, confidence: z.number().min(0).max(1) })),
      placeholder_node_id: UuidSchema.optional(),
    }),
  ),
  scope_status: z.literal('pending_review'),
});

// ---------------------------------------------------------------- plan-recompute and vespera (GOL-04, GOL-07)

export const PlanRecomputeReqSchema = z.object({
  trigger: z.enum(PLAN_TRIGGER),
  goal_id: UuidSchema.optional(),
  local_date: LocalDateSchema.optional(),
});
export type PlanRecomputeReq = z.infer<typeof PlanRecomputeReqSchema>;

export const PlanRecomputeResSchema = z.object({
  plan_run_id: UuidSchema,
  version: z.int().min(1),
  feasible: z.boolean(),
  triage: z
    .object({ dropped_node_ids: z.array(UuidSchema), reason_key: z.string().min(1) })
    .optional(),
  items_changed: z.int().min(0),
});

export const VesperaPrepareReqSchema = z.object({ exam_id: UuidSchema });
export const VesperaPrepareResSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), sheet_note_id: UuidSchema }),
  z.object({ status: z.literal('preparing'), job_id: UuidSchema }),
]);

// ---------------------------------------------------------------- prova-provavel-generate (PRA-09, Phase 2)

export const ProvaProvavelGenerateReqSchema = z.object({
  exam_id: UuidSchema,
  regenerate: z.boolean().optional(),
});
/** 202: progress through `ai_jobs`; the result is a `quizzes.kind = predicted_test`. */
export const ProvaProvavelGenerateResSchema = z.object({
  job_id: UuidSchema,
  quiz_id_when_ready: z.null().optional(),
});
