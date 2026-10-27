// Zod schemas for the jsonb columns of the Phase 0–2 schema (data-model §1.2 and §5.1).
// The DB only checks the top-level type; these run in the app, Edge Functions and the worker.
import { z } from 'zod';
import { TUTOR_SCOPE_TYPE, type TutorScopeType } from '../enums.ts';
import { IsoInstantSchema, LocalDateSchema, StoragePathSchema, TimeOfDaySchema, UuidSchema } from './common.ts';

// ---------------------------------------------------------------- §1.2 shared shapes

/** `Formula` (knowledge_nodes.formulas[]). */
export const FormulaSchema = z.object({ latex: z.string().min(1), description: z.string() });
export const FormulasSchema = z.array(FormulaSchema);

const unitInterval = z.number().min(0).max(1);

/** `Media` for cards: an image, or an image-occlusion card with masks (x/y/w/h normalized 0–1). */
export const ImageMediaSchema = z.object({
  path: StoragePathSchema,
  width: z.int().min(1),
  height: z.int().min(1),
});

export const OcclusionMaskSchema = z.object({
  id: z.string().min(1),
  x: unitInterval,
  y: unitInterval,
  w: unitInterval,
  h: unitInterval,
  label: z.string(),
});

export const OcclusionMediaSchema = ImageMediaSchema.extend({
  mode: z.enum(['hide_one', 'hide_all']),
  masks: z.array(OcclusionMaskSchema).min(1),
  target_mask_id: z.string().min(1),
});

export const MediaSchema = z.union([OcclusionMediaSchema, ImageMediaSchema]);

/** `ReasonRef`: an i18n key plus params, never prose (plan_items.reason_*). */
export const ReasonRefSchema = z.object({
  key: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------- tutor (§5.6)

/** `passage` of tutor_threads and tutor-chat scopes (api §4.4). */
export const TutorPassageSchema = z.object({
  source: z.enum(['note', 'pdf']),
  document_id: UuidSchema.optional(),
  note_id: UuidSchema.optional(),
  page: z.int().min(1).optional(),
  text: z.string().min(1),
  rect: z.unknown().optional(),
  image_path: StoragePathSchema.optional(),
});

/** Scope of a tutor thread. The id column matching `type` must be set (data-model §5.6 check). */
export const TutorScopeSchema = z
  .object({
    type: z.enum(TUTOR_SCOPE_TYPE),
    subject_id: UuidSchema.optional(),
    goal_id: UuidSchema.optional(),
    node_id: UuidSchema.optional(),
    capture_id: UuidSchema.optional(),
    passage: TutorPassageSchema.optional(),
  })
  .superRefine((scope, ctx) => {
    const required: Record<TutorScopeType, keyof typeof scope> = {
      subject: 'subject_id',
      goal: 'goal_id',
      topic: 'node_id',
      passage: 'passage',
      capture: 'capture_id',
    };
    const field = required[scope.type];
    if (scope[field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `scope.${String(field)} is required for ${scope.type}` });
    }
  });

/** `tutor_threads.context_pages`: pages already sent in the context pack. */
export const ContextPagesSchema = z.array(z.object({ document_id: UuidSchema, page: z.int().min(1) }));

// ---------------------------------------------------------------- study, plan, practice

/** `study_sessions.activities`: `[{type, ref_id, count}]` (data-model §5.5). */
export const ActivitiesSchema = z.array(
  z.object({ type: z.string().min(1), ref_id: UuidSchema.optional(), count: z.int().min(0) }),
);

/** `quizzes.scope` (data-model §5.4). */
export const QuizScopeSchema = z.object({
  exam_id: UuidSchema.optional(),
  goal_id: UuidSchema.optional(),
  subject_id: UuidSchema.optional(),
  node_ids: z.array(UuidSchema).optional(),
  weak_only: z.boolean().optional(),
  /** Chefão (MOT-02.4): the unit whose topics the boss mixes. */
  unit_node_id: UuidSchema.optional(),
});

/** Modo Desespero topic grouping, `desperate_modes.topic_groups` (GOL-12). */
export const TopicGroupSchema = z.enum(['focus', 'basic', 'out']);
export const TopicGroupsSchema = z.record(UuidSchema, TopicGroupSchema);

// ---------------------------------------------------------------- profiles.settings (§5.1)

// Nested objects are partial in storage too: a stored `notifications` may set only some channels.
const memorySettings = z
  .object({
    desired_retention: z.number().min(0.8).max(0.97),
    new_per_day: z.int().min(0),
    max_reviews_per_day: z.int().min(0),
    fsrs_params: z.array(z.number()),
    fsrs_params_version: z.string(),
    fsrs_optimized_at: IsoInstantSchema,
    reminders_enabled: z.boolean(),
    class_hours: z.unknown(),
  })
  .partial();

/** `profiles.settings` (ProfileSettings). Every key is optional in storage; defaults applied on read. */
export const ProfileSettingsSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    notifications: z
      .object({ reviews: z.boolean(), plan: z.boolean(), class: z.boolean(), processing: z.boolean() })
      .partial(),
    storage_quota_mb: z.union([z.literal(250), z.literal(500), z.literal(1000), z.literal(2000)]),
    memory: memorySettings,
    feed: z
      .object({ session_minutes: z.int().min(1), daily_soft_limit_min: z.int().min(0), bedtime: TimeOfDaySchema })
      .partial(),
    tutor_personalization: z.boolean(),
    allow_general_answers: z.boolean(),
    tutor_voice: z.object({ voice_id: z.string(), rate: z.number().positive() }).partial(),
    tts: z.object({ voice_id: z.string(), rate: z.number().positive() }).partial(),
    daily_goal_minutes: z.int().min(0),
    reminders_enabled: z.boolean(),
    wellbeing_nudges_enabled: z.boolean(),
    checkin_enabled: z.boolean(),
    reduce_motion: z.boolean(),
    high_contrast: z.boolean(),
    font_family: z.enum(['system', 'atkinson', 'opendyslexic']),
    letter_spacing: z.number(),
    line_height: z.number(),
    time_extension: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
    mascot: z.object({ visible: z.boolean(), accessories: z.array(z.string()) }).partial(),
    /** MOT-04.1 semester ends as MM-DD (default end of June and end of November). */
    semester_ends: z.array(z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)).min(1).max(4),
    flags: z.array(z.string()),
  })
  .partial();

export type ProfileSettings = z.infer<typeof ProfileSettingsSchema>;

/** Defaults from data-model §5.1. Keys without a documented default are left out. */
export const PROFILE_SETTINGS_DEFAULTS = {
  theme: 'system',
  notifications: { reviews: true, plan: true, class: true, processing: true },
  storage_quota_mb: 500,
  memory: { desired_retention: 0.9 },
  feed: { session_minutes: 10, daily_soft_limit_min: 45, bedtime: '23:00' },
  tutor_personalization: true,
  allow_general_answers: false,
  daily_goal_minutes: 20,
  reminders_enabled: true,
  wellbeing_nudges_enabled: true,
  checkin_enabled: false,
  reduce_motion: false,
  high_contrast: false,
  font_family: 'system',
  time_extension: 1,
  mascot: { visible: true, accessories: [] as string[] },
  flags: [] as string[],
} as const satisfies ProfileSettings;

/**
 * Parses stored `profiles.settings` and fills in defaults. Nested objects are merged key by key so a
 * partial `notifications` object keeps the other channels on. Throws when a stored value is invalid.
 */
export function parseProfileSettings(raw: unknown): ProfileSettings {
  const parsed = ProfileSettingsSchema.parse(raw ?? {});
  const d = PROFILE_SETTINGS_DEFAULTS;
  return {
    ...d,
    ...parsed,
    notifications: { ...d.notifications, ...parsed.notifications },
    memory: { ...d.memory, ...parsed.memory },
    feed: { ...d.feed, ...parsed.feed },
    mascot: { ...d.mascot, ...parsed.mascot },
  };
}
