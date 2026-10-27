// Sync protocol (api.md §3.2 and §4.1 `sync-push`, mobile-app.md §4.3, data-model §9.2, ADR 0007).
// Offline mutations are outbox rows; the device pushes them in batches and pulls changes per table.
import { z } from 'zod';
import {
  ATTEMPT_STATUS,
  FEED_IMPRESSION_ACTION,
  FEED_IMPRESSION_KIND,
  FLAG_REASON,
  HIGHLIGHT_COLOR,
  INPUT_MODE,
  ITEM_TYPE,
  MISTAKE_CAUSE,
  NOTE_DEPTH,
  PLAN_ITEM_STATUS,
  REVIEW_REASON,
  REVIEW_SOURCE,
  STUDY_SESSION_KIND,
} from '../enums.ts';
import { FeatureIdSchema } from '../enums.ts';
import { ActivitiesSchema } from './jsonb.ts';
import { IsoInstantSchema, LocalDateSchema, TimeOfDaySchema, Uuid7Schema, UuidSchema } from './common.ts';

/** Current client/server sync schema version (api §2.1 `x-studify-schema`). */
export const SYNC_SCHEMA_VERSION = 1;
/** Max outbox rows per push (api §4.1, mobile-app §4.3). */
export const SYNC_PUSH_MAX_ITEMS = 200;
/** Max rows per table pull (api §3.2). */
export const SYNC_PULL_PAGE_LIMIT = 500;
/** Cursor value used before the first pull. */
export const SYNC_INITIAL_CURSOR = { updated_at: '1970-01-01T00:00:00Z', last_id: '00000000-0000-0000-0000-000000000000' };

/** True when a client may talk to this server. Newer schemas get 426 `app_update_required` (api §2.1). */
export function isSupportedSyncSchemaVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= SYNC_SCHEMA_VERSION;
}

/** Outbox `kind` values (api §4.1 `OutboxKind`). */
export const SYNC_OUTBOX_KINDS = [
  'review_log',
  'quiz_attempt',
  'attempt_answer',
  'plan_item_status',
  'card_override',
  'card_state_flag',
  'node_user_setting',
  'subject_user_setting',
  'mistake_update',
  'note_highlight',
  'flag',
  'feed_impression',
  'xp_event',
  'study_session',
  'topic_read',
  'podcast_play',
  'study_preferences',
] as const;
export type SyncOutboxKind = (typeof SYNC_OUTBOX_KINDS)[number];

/** Why the server refused one outbox row (api §4.1 `rejected[].code`). `drop` tells the device to discard it. */
export const SYNC_REJECT_CODES = ['invalid', 'forbidden', 'not_found', 'stale'] as const;
export type SyncRejectCode = (typeof SYNC_REJECT_CODES)[number];

// ---------------------------------------------------------------- payloads, one per kind

/** `review_log`: append-only FSRS rating (ADR 0007). The outbox `id` is the review_logs id. */
export const ReviewLogPayloadSchema = z.object({
  card_id: UuidSchema,
  rating: z.int().min(1).max(4), // 1 Errei · 2 Difícil · 3 Bom · 4 Fácil
  reviewed_at: IsoInstantSchema, // clamped by the server when > 5 min in the future
  client_reviewed_at: IsoInstantSchema,
  elapsed_days: z.int().min(0).optional(),
  scheduled_days: z.int().min(0).optional(),
  state_before: z.int().min(0).max(3).optional(),
  duration_ms: z.int().min(0).optional(),
  source: z.enum(REVIEW_SOURCE).optional(),
  reason: z.enum(REVIEW_REASON).optional(),
  hint_used: z.boolean().optional(),
  undoes_log_id: Uuid7Schema.optional(), // MEM-02.8 undo marker
  device_id: z.string().min(1).max(128).optional(),
});

export const QuizAttemptPayloadSchema = z.object({
  quiz_id: UuidSchema,
  status: z.enum(ATTEMPT_STATUS),
  started_at: IsoInstantSchema,
  finished_at: IsoInstantSchema.nullable().optional(),
  paused_seconds: z.int().min(0).optional(),
  device_id: z.string().min(1).max(128),
});

/** `attempt_answer`: the outbox id is the attempt_answers id. Unique (attempt_id, question_id). */
export const AttemptAnswerPayloadSchema = z.object({
  attempt_id: UuidSchema,
  question_id: UuidSchema,
  question_version: z.int().min(1),
  response: z.unknown().optional(), // null = blank answer
  confidence: z.int().min(1).max(4).optional(), // PRA-05
  time_spent_ms: z.int().min(0),
  hints_used: z.int().min(0).optional(),
  solution_viewed: z.boolean().optional(),
  marked_for_review: z.boolean().optional(),
  input_mode: z.enum(INPUT_MODE).optional(),
  essay_id: UuidSchema.optional(),
  answered_at: IsoInstantSchema,
});

/** Last-writer-wins edits. `updated_at` is the device time, clamped by the server (ADR 0007 §7). */
export const PlanItemStatusPayloadSchema = z
  .object({
    plan_item_id: UuidSchema,
    status: z.enum(PLAN_ITEM_STATUS).optional(),
    pinned: z.boolean().optional(),
    updated_at: IsoInstantSchema,
  })
  .refine((p) => p.status !== undefined || p.pinned !== undefined, { message: 'status or pinned is required' });

export const CardOverridePayloadSchema = z.object({
  card_id: UuidSchema,
  front: z.string().nullable().optional(),
  back: z.string().nullable().optional(),
  media: z.unknown().nullable().optional(),
  updated_at: IsoInstantSchema,
});

export const CardStateFlagPayloadSchema = z.object({
  card_id: UuidSchema,
  field: z.enum(['suspended', 'hidden', 'is_leech']), // R7: "Excluir pra mim" is `hidden`
  value: z.boolean(),
  updated_at: IsoInstantSchema,
});

export const NodeUserSettingPayloadSchema = z.object({
  node_id: UuidSchema,
  excluded: z.boolean(), // R1: "não cai na prova"
  updated_at: IsoInstantSchema,
});

export const SubjectUserSettingPayloadSchema = z.object({
  subject_id: UuidSchema,
  pinned: z.boolean().optional(),
  sort_order: z.int().optional(),
  archived_at: IsoInstantSchema.nullable().optional(),
  updated_at: IsoInstantSchema,
});

export const MistakeUpdatePayloadSchema = z.object({
  question_id: UuidSchema,
  cause: z.enum(MISTAKE_CAUSE).optional(),
  user_note: z.string().max(500).nullable().optional(), // "O que eu aprendi"
  updated_at: IsoInstantSchema,
});

export const NoteHighlightPayloadSchema = z.object({
  note_id: UuidSchema,
  start: z.int().min(0),
  end: z.int().min(0),
  quote: z.string(),
  color: z.enum(HIGHLIGHT_COLOR),
  orphaned: z.boolean().optional(),
  deleted_at: IsoInstantSchema.nullable().optional(),
  updated_at: IsoInstantSchema,
}).refine((h) => h.end >= h.start, { message: 'end must be >= start' });

/** `flag`: a content report queued offline (TRU-02). Same fields as the `flag-create` request. */
export const FlagPayloadSchema = z.object({
  item_type: z.enum(ITEM_TYPE),
  item_id: UuidSchema,
  item_version: z.int().min(1),
  reason: z.enum(FLAG_REASON),
  comment: z.string().max(500).optional(),
});

export const FeedImpressionPayloadSchema = z.object({
  feed_item_id: UuidSchema.nullable().optional(),
  item_kind: z.enum(FEED_IMPRESSION_KIND),
  item_ref_id: UuidSchema,
  session_id: UuidSchema,
  shown_at: IsoInstantSchema,
  dwell_ms: z.int().min(0).optional(),
  action: z.enum(FEED_IMPRESSION_ACTION).optional(),
  helpful: z.boolean().nullable().optional(),
});

/** `xp_event` (MOT-01): the outbox id is the xp_events id; the server dedupes on (user, ref, feature). */
export const XpEventPayloadSchema = z.object({
  amount: z.int(),
  source_feature: FeatureIdSchema,
  ref_type: z.string().min(1),
  ref_id: UuidSchema,
  occurred_at: IsoInstantSchema,
  local_date: LocalDateSchema,
  in_quiet_hours: z.boolean(),
});

export const StudySessionPayloadSchema = z.object({
  kind: z.enum(STUDY_SESSION_KIND),
  plan_item_id: UuidSchema.nullable().optional(),
  goal_id: UuidSchema.nullable().optional(),
  started_at: IsoInstantSchema,
  ended_at: IsoInstantSchema.nullable().optional(),
  active_minutes: z.int().min(0).optional(),
  activities: ActivitiesSchema.optional(),
  planned_focus_minutes: z.int().min(0).nullable().optional(),
  cycles_planned: z.int().min(0).nullable().optional(),
  cycles_done: z.int().min(0).nullable().optional(),
  interruptions: z.int().min(0).nullable().optional(),
  blocked_attempts: z.int().min(0).nullable().optional(),
  dnd_used: z.boolean().optional(),
});

export const TopicReadPayloadSchema = z.object({
  node_id: UuidSchema,
  depth: z.enum(NOTE_DEPTH),
  read_at: IsoInstantSchema,
  seconds: z.int().min(0),
});

export const PodcastPlayPayloadSchema = z.object({
  episode_id: UuidSchema,
  position_ms: z.int().min(0),
  completed_at: IsoInstantSchema.nullable().optional(),
  downloaded: z.boolean().optional(),
  updated_at: IsoInstantSchema,
});

/** Partial study preferences edited offline (GOL-04, GOL-10, MEM-04, PLT-05). */
export const StudyPreferencesPayloadSchema = z.object({
  minutes_by_weekday: z.array(z.int().min(0)).length(7).optional(), // Mon…Sun
  window_start: TimeOfDaySchema.optional(),
  window_end: TimeOfDaySchema.optional(),
  min_block_min: z.int().min(1).optional(),
  max_block_min: z.int().min(1).optional(),
  max_subjects_per_day: z.int().min(1).optional(),
  quiet_start: TimeOfDaySchema.optional(),
  quiet_end: TimeOfDaySchema.optional(),
  vespera_time: TimeOfDaySchema.optional(),
  day_rollover_hour: z.int().min(0).max(6).optional(), // R9
  enem_min_share: z.number().min(0).max(1).optional(),
  review_seconds_estimate: z.number().positive().optional(),
  updated_at: IsoInstantSchema,
});

/** Payload schema per kind. `sync-push` validates each row with the schema of its kind. */
export const OUTBOX_PAYLOAD_SCHEMAS = {
  review_log: ReviewLogPayloadSchema,
  quiz_attempt: QuizAttemptPayloadSchema,
  attempt_answer: AttemptAnswerPayloadSchema,
  plan_item_status: PlanItemStatusPayloadSchema,
  card_override: CardOverridePayloadSchema,
  card_state_flag: CardStateFlagPayloadSchema,
  node_user_setting: NodeUserSettingPayloadSchema,
  subject_user_setting: SubjectUserSettingPayloadSchema,
  mistake_update: MistakeUpdatePayloadSchema,
  note_highlight: NoteHighlightPayloadSchema,
  flag: FlagPayloadSchema,
  feed_impression: FeedImpressionPayloadSchema,
  xp_event: XpEventPayloadSchema,
  study_session: StudySessionPayloadSchema,
  topic_read: TopicReadPayloadSchema,
  podcast_play: PodcastPlayPayloadSchema,
  study_preferences: StudyPreferencesPayloadSchema,
} as const;

function outboxItem<K extends SyncOutboxKind, P extends z.ZodType>(kind: K, payload: P) {
  return z.object({
    id: Uuid7Schema,
    kind: z.literal(kind),
    payload,
    created_at: IsoInstantSchema,
  });
}

/** One outbox row as pushed. Discriminated on `kind`, so each payload is checked against its own schema. */
export const OutboxItemSchema = z.discriminatedUnion('kind', [
  outboxItem('review_log', ReviewLogPayloadSchema),
  outboxItem('quiz_attempt', QuizAttemptPayloadSchema),
  outboxItem('attempt_answer', AttemptAnswerPayloadSchema),
  outboxItem('plan_item_status', PlanItemStatusPayloadSchema),
  outboxItem('card_override', CardOverridePayloadSchema),
  outboxItem('card_state_flag', CardStateFlagPayloadSchema),
  outboxItem('node_user_setting', NodeUserSettingPayloadSchema),
  outboxItem('subject_user_setting', SubjectUserSettingPayloadSchema),
  outboxItem('mistake_update', MistakeUpdatePayloadSchema),
  outboxItem('note_highlight', NoteHighlightPayloadSchema),
  outboxItem('flag', FlagPayloadSchema),
  outboxItem('feed_impression', FeedImpressionPayloadSchema),
  outboxItem('xp_event', XpEventPayloadSchema),
  outboxItem('study_session', StudySessionPayloadSchema),
  outboxItem('topic_read', TopicReadPayloadSchema),
  outboxItem('podcast_play', PodcastPlayPayloadSchema),
  outboxItem('study_preferences', StudyPreferencesPayloadSchema),
]);
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

// ---------------------------------------------------------------- sync-push request and response

/** `POST /functions/v1/sync-push` body (api §4.1). Max 200 rows, in local creation order. */
export const SyncPushReqSchema = z.object({
  schema_version: z.int().min(1),
  device_id: z.string().min(1).max(128),
  items: z.array(OutboxItemSchema).min(1).max(SYNC_PUSH_MAX_ITEMS),
});
export type SyncPushReq = z.infer<typeof SyncPushReqSchema>;

/** Authoritative FSRS state returned for every card a push touched (ADR 0007 §4). Mirrors card_states. */
export const SyncCardStateSchema = z.object({
  card_id: UuidSchema,
  due: IsoInstantSchema,
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.int().min(0),
  scheduled_days: z.int().min(0),
  reps: z.int().min(0),
  lapses: z.int().min(0),
  state: z.int().min(0).max(3), // 0 New · 1 Learning · 2 Review · 3 Relearning
  learning_steps: z.int().min(0),
  last_review: IsoInstantSchema.nullable(),
  suspended: z.boolean(),
  hidden: z.boolean(),
  is_leech: z.boolean(),
  introduced_at: IsoInstantSchema.nullable(),
  updated_at: IsoInstantSchema,
});
export type SyncCardState = z.infer<typeof SyncCardStateSchema>;

export const SyncPushResSchema = z.object({
  acked: z.array(Uuid7Schema), // processed, or already processed (idempotent)
  rejected: z.array(
    z.object({ id: Uuid7Schema, code: z.enum(SYNC_REJECT_CODES), drop: z.boolean() }),
  ),
  card_states: z.array(SyncCardStateSchema),
  server_time: IsoInstantSchema,
});
export type SyncPushRes = z.infer<typeof SyncPushResSchema>;

// ---------------------------------------------------------------- pull cursors

/** Tables mirrored to the device (data-model §9.1, Phases 1–2). Pull order follows this list. */
export const SYNC_MIRROR_TABLES = [
  'profiles',
  'study_preferences',
  'subjects',
  'subject_user_settings',
  'knowledge_nodes',
  'node_sources',
  'glossary_terms',
  'node_user_settings',
  'notes',
  'cards',
  'card_overrides',
  'card_states',
  'review_logs',
  'goals',
  'exams',
  'exam_scope_nodes',
  'plan_items',
  'mistakes',
  'study_sessions',
  'questions',
  'quizzes',
  'quiz_attempts',
  'attempt_answers',
  'feed_items',
  'mastery',
  'daily_activity',
  'streaks',
  'achievements',
  'note_highlights',
] as const;
export type SyncMirrorTable = (typeof SYNC_MIRROR_TABLES)[number];

/** Per-table pull cursor stored in the local `sync_cursors` table (data-model §9.2). */
export const SyncCursorSchema = z.object({
  table_name: z.enum(SYNC_MIRROR_TABLES),
  updated_at: IsoInstantSchema,
  last_id: UuidSchema,
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

/**
 * Pull filter (api §3.2): rows with `updated_at > cursor` or (`updated_at = cursor` and `id > last_id`),
 * ordered by (updated_at, id), at most SYNC_PULL_PAGE_LIMIT rows. Tombstones are included.
 * `cursorAfter` builds the next cursor from the last row of a page.
 */
export function cursorAfter(row: { updated_at: string; id: string }): Pick<SyncCursor, 'updated_at' | 'last_id'> {
  return { updated_at: row.updated_at, last_id: row.id };
}
