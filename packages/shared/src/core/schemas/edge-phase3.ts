// API payloads of Phase 3 (api.md §4.5 grade-essay, §4.7 room-control, §4.8 interactive learning and
// camera): Câmera Mágica, PRA-06/07/08 helpers, Podcast Interativo, Ensine o Lucas and Salas de estudo.
// Streaming endpoints (capture-act explain/solution, podcast-ask, teaching-turn) use sse.ts events.
import { z } from 'zod';
import {
  CAPTURE_CONTENT_TYPE,
  PODCAST_STATUS,
  PODCAST_STYLE,
  ROOM_REACTIONS,
  ROOM_STATUS,
  ROOM_STATUS_MODE,
  TEACHING_LENGTH,
  VOICE_INPUT_MODE,
} from '../enums.ts';
import { SourcePagesSchema } from '../citations.ts';
import { UuidSchema } from './common.ts';

// ---------------------------------------------------------------- Câmera Mágica (CAM-01…03)

export const CAPTURE_QUALITY_ISSUES = ['blur', 'glare', 'partial', 'dark', 'multiple_questions', 'handwriting'] as const;

export const CaptureAnalyzeReqSchema = z.object({
  capture_id: UuidSchema,
  /** CAM-02.1: when the photo has several questions the client may already know which one it wants. */
  question_index: z.int().min(0).optional(),
});
export type CaptureAnalyzeReq = z.infer<typeof CaptureAnalyzeReqSchema>;

export const CaptureMatchSchema = z.object({
  subject_id: UuidSchema,
  node_ids: z.array(UuidSchema),
  confidence: z.number().min(0).max(1),
  /** "Biologia › Genética › 1ª Lei de Mendel" (CAM-02.3). */
  label: z.string(),
});

export const CaptureAnalyzeResSchema = z.object({
  content_type: z.enum(CAPTURE_CONTENT_TYPE),
  quality: z.object({ ok: z.boolean(), issues: z.array(z.enum(CAPTURE_QUALITY_ISSUES)) }),
  /** Line breaks preserved; unreadable spans marked ⟦?⟧ (api §4.8). */
  transcription: z.string(),
  detected_questions: z.array(
    z.object({ index: z.int().min(0), label: z.string(), preview: z.string(), complete: z.boolean(), has_figure: z.boolean() }),
  ),
  match: CaptureMatchSchema.nullable(),
  key_concepts: z.array(z.string()),
});
export type CaptureAnalyzeRes = z.infer<typeof CaptureAnalyzeResSchema>;

/** capture-act: one request shape per intent (api §4.8). `explain` and `solve` + `solution` stream (SSE). */
export const CaptureActReqSchema = z.discriminatedUnion('intent', [
  z.object({
    capture_id: UuidSchema,
    intent: z.literal('explain'),
    /** CAM-01.2 "Explica só isso": one paragraph of the transcription. */
    focus_text: z.string().min(1).max(2000).optional(),
  }),
  z.object({
    capture_id: UuidSchema,
    intent: z.literal('solve'),
    question_index: z.int().min(0).optional(),
    reveal: z.enum(['hint', 'next_hint', 'solution']),
  }),
  z.object({ capture_id: UuidSchema, intent: z.literal('check_answer'), answer: z.string().min(1).max(500) }),
  z.object({ capture_id: UuidSchema, intent: z.literal('add_to_subject'), subject_id: UuidSchema }),
  z.object({ capture_id: UuidSchema, intent: z.literal('save_question'), subject_id: UuidSchema.optional(), node_id: UuidSchema.optional() }),
  z.object({
    capture_id: UuidSchema,
    intent: z.enum(['grade_answer', 'grade_essay']),
    /** CAM-03.4: the transcription as the student confirmed it. */
    confirmed_text: z.string().min(1).max(20_000),
    question_id: UuidSchema.optional(),
    /** PRA-07.1 "Tenho uma questão da professora": the question text when there is no stored question. */
    question_text: z.string().min(1).max(4000).optional(),
    max_points: z.number().positive().max(100).optional(),
    subject_id: UuidSchema.optional(),
    theme_id: UuidSchema.optional(),
  }),
]);
export type CaptureActReq = z.infer<typeof CaptureActReqSchema>;

export const HintStepSchema = z.object({ level: z.int().min(1), text_md: z.string() });

export const CaptureActResSchema = z.union([
  z.object({
    intent: z.literal('solve'),
    hint_level: z.int().min(0),
    total_levels: z.int().min(1),
    hints: z.array(HintStepSchema),
    /** Present only once the last level is reached (CAM-02.4: the answer never leaves the server earlier). */
    final: z.object({ answer: z.string(), why_others_wrong: z.array(z.object({ option: z.string(), reason: z.string() })) }).optional(),
    assumptions: z.array(z.string()),
  }),
  z.object({ intent: z.literal('check_answer'), correct: z.boolean(), message: z.string(), hint_level: z.int().min(0) }),
  z.object({ intent: z.literal('add_to_subject'), document_id: UuidSchema, job_id: UuidSchema }),
  z.object({ intent: z.literal('save_question'), question_id: UuidSchema }),
  z.object({ intent: z.enum(['grade_answer', 'grade_essay']), essay_id: UuidSchema, next: z.literal('grade-essay'), heavily_edited: z.boolean() }),
]);
export type CaptureActRes = z.infer<typeof CaptureActResSchema>;

// ---------------------------------------------------------------- PRA-07 essay grading, PRA-08 first wrong step

export const GradeEssayReqSchema = z.object({ essay_id: UuidSchema });

export const EssayCriterionSchema = z.object({
  id: z.string().min(1),
  criterion: z.string(),
  points: z.number().min(0),
  max_points: z.number().min(0),
  verdict: z.enum(['full', 'partial', 'none']),
  comment: z.string(),
});

/** PRA-07.5 result, stored in essays.feedback for school answers. */
export const SchoolEssayFeedbackSchema = z.object({
  points_awarded: z.number().min(0),
  points_max: z.number().positive(),
  score: z.number().min(0).max(1),
  criteria: z.array(EssayCriterionSchema),
  strengths: z.array(z.string()),
  missing: z.array(z.object({ text: z.string(), source_pages: SourcePagesSchema })),
  model_answer: z.string(),
  misconceptions: z.array(z.string()),
  suggested_cause: z.enum(['didnt_know', 'confused', 'careless', 'misread']).nullable(),
  grader_confidence: z.enum(['high', 'medium', 'low']),
  /** PRA-07.3: the rubric the grader built for a user-provided question. */
  built_rubric: z.boolean(),
  heavily_edited: z.boolean(),
  illegible_segments: z.int().min(0),
  /** PRA-07.8: difference to the previous version, in points. */
  delta_points: z.number().nullable(),
});
export type SchoolEssayFeedback = z.infer<typeof SchoolEssayFeedbackSchema>;

export const GradeEssayResSchema = z.union([
  z.object({ mode: z.literal('sync'), essay: z.object({ id: UuidSchema, status: z.literal('graded'), feedback: SchoolEssayFeedbackSchema }) }),
  z.object({ mode: z.literal('async'), job_id: UuidSchema, eta_s: z.int().min(1) }),
]);
export type GradeEssayRes = z.infer<typeof GradeEssayResSchema>;

export const ProblemCheckWorkReqSchema = z.object({
  question_id: UuidSchema,
  /** "Mostrar meu raciocínio" (PRA-08.5): typed working or a confirmed transcription. */
  working: z.string().min(1).max(6000),
});
export const ProblemCheckWorkResSchema = z.object({
  first_wrong_step_index: z.int().min(0).nullable(),
  what_went_wrong: z.string(),
  nudge: z.string(),
});
export type ProblemCheckWorkRes = z.infer<typeof ProblemCheckWorkResSchema>;

// ---------------------------------------------------------------- Podcast Interativo (INT-01)

export const PodcastCreateReqSchema = z.object({
  subject_id: UuidSchema,
  node_ids: z.array(UuidSchema).min(1).max(30),
  style: z.enum(PODCAST_STYLE),
  length_minutes: z.union([z.literal(5), z.literal(10), z.literal(15)]),
  exam_id: UuidSchema.optional(),
});
export type PodcastCreateReq = z.infer<typeof PodcastCreateReqSchema>;

export const PodcastCreateResSchema = z.object({
  episode_id: UuidSchema,
  status: z.enum(PODCAST_STATUS),
  /** INT-01.6: a cached episode (shared in the Turma) was returned at no cost. */
  cached: z.boolean(),
  dropped_topics: z.array(z.string()),
});
export type PodcastCreateRes = z.infer<typeof PodcastCreateResSchema>;

export const PodcastAskReqSchema = z.object({
  episode_id: UuidSchema,
  position_ms: z.int().min(0),
  segment_id: z.string().min(1).max(40).optional(),
  question_text: z.string().min(1).max(500),
  input_mode: z.enum(VOICE_INPUT_MODE),
});
export type PodcastAskReq = z.infer<typeof PodcastAskReqSchema>;

/** `done.result` of podcast-ask. */
export const PodcastAskResultSchema = z.object({
  interaction_id: UuidSchema,
  lines: z.array(z.object({ speaker: z.enum(['bia', 'caio']), text: z.string() })),
  out_of_material: z.boolean(),
  answer_audio_url: z.string().nullable(),
  tts_fallback: z.boolean(),
  resume_at_ms: z.int().min(0),
});

// ---------------------------------------------------------------- Ensine o Lucas (INT-02)

export const TeachingStartReqSchema = z.object({ node_id: UuidSchema, length: z.enum(TEACHING_LENGTH) });
export const TeachingStartResSchema = z.object({
  session_id: UuidSchema,
  opening: z.string(),
  turn_limit: z.int().min(1),
  /** An open lesson on the same topic was resumed instead of creating a new one. */
  resumed: z.boolean(),
  messages: z.array(z.object({ role: z.enum(['student', 'lucas']), text: z.string() })),
});
export type TeachingStartRes = z.infer<typeof TeachingStartResSchema>;

export const TeachingTurnReqSchema = z.object({
  session_id: UuidSchema,
  message: z.string().min(1).max(2000),
  input_mode: z.enum(VOICE_INPUT_MODE).optional(),
});
export type TeachingTurnReq = z.infer<typeof TeachingTurnReqSchema>;

export const TeachingFinishReqSchema = z.object({ session_id: UuidSchema });
export const TeachingFinishResSchema = z.object({
  score: z.int().min(0).max(100).nullable(),
  too_short: z.boolean(),
  band: z.enum(['confused', 'almost', 'good', 'born_teacher']).nullable(),
  rubric: z.object({ misconceptions: z.number(), coverage: z.number(), accuracy: z.number(), clarity: z.number() }),
  gaps: z.array(z.object({ kind: z.enum(['misconception', 'concept']), id: z.string(), text: z.string(), correct: z.string(), source_pages: SourcePagesSchema })),
  errors_taught: z.array(z.object({ claim: z.string(), correction: z.string(), severity: z.enum(['minor', 'major']), source_pages: SourcePagesSchema })),
  teach_back: z.string(),
});
export type TeachingFinishRes = z.infer<typeof TeachingFinishResSchema>;

// ---------------------------------------------------------------- Salas de estudo (SOC-05)

export const RoomTimerConfigSchema = z.object({ focus_min: z.int().min(5).max(120), break_min: z.int().min(1).max(30) });
export const RoomGroupGoalSchema = z.object({ kind: z.enum(['cards', 'questions']), target: z.int().min(10).max(5000) });

export const RoomControlReqSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    class_group_id: UuidSchema,
    name: z.string().min(2).max(40),
    timer_config: RoomTimerConfigSchema.optional(),
    group_goal: RoomGroupGoalSchema.optional(),
  }),
  z.object({ action: z.literal('join'), room_id: UuidSchema, status_mode: z.enum(ROOM_STATUS_MODE).optional() }),
  z.object({ action: z.literal('leave'), room_id: UuidSchema }),
  z.object({ action: z.enum(['start', 'pause', 'resume', 'skip', 'close']), room_id: UuidSchema }),
  z.object({ action: z.literal('react'), room_id: UuidSchema, reaction: z.enum(ROOM_REACTIONS) }),
  z.object({ action: z.literal('status'), room_id: UuidSchema, status_mode: z.enum(ROOM_STATUS_MODE) }),
]);
export type RoomControlReq = z.infer<typeof RoomControlReqSchema>;

export const RoomControlResSchema = z.object({
  room_id: UuidSchema,
  status: z.enum(ROOM_STATUS),
  timer_state: z.record(z.string(), z.unknown()),
  timer_config: RoomTimerConfigSchema,
  goal: z.object({ progress: z.int().min(0), target: z.int().min(1), kind: z.enum(['cards', 'questions']) }).nullable(),
  members: z.int().min(0),
});
export type RoomControlRes = z.infer<typeof RoomControlResSchema>;
