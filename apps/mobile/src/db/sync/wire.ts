// Outbox row -> wire payload for `sync-push` (api §4.1, packages/shared sync schemas). The app writes
// payloads for its own screens; this module shapes each one to the server contract when it is sent, so rows
// queued before a fix are sent correctly too. Nothing is stored back: the outbox keeps the app's payload.
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import type { OutboxRow } from '../outbox';
import { questions } from '../schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fields the server schema accepts as null. Every other null is sent as an absent key: the wire schemas use
 * `.optional()`, which rejects null, so a null the app sends (for example `duration_ms`) would drop the row.
 */
const NULLABLE_ON_WIRE: Partial<Record<string, readonly string[]>> = {
  quiz_attempt: ['finished_at'],
  study_session: ['ended_at', 'plan_item_id', 'goal_id', 'planned_focus_minutes', 'cycles_planned', 'cycles_done', 'interruptions', 'blocked_attempts'],
  feed_impression: ['feed_item_id'],
  card_override: ['front', 'back', 'media'],
  subject_user_setting: ['archived_at'],
  mistake_update: ['user_note'],
  note_highlight: ['deleted_at'],
  podcast_play: ['completed_at'],
};

export interface WireContext {
  /** Stable per-install id: a quiz attempt is stored with the device that submitted it. */
  deviceId: string;
  /** Local `questions.version` of a question, or null when the question is not on this device. */
  questionVersion: (questionId: string) => number | null;
}

/** Local question version lookup, for the attempt answers (the server stores the version that was answered). */
export function questionVersionLookup(db: Db): WireContext['questionVersion'] {
  return (questionId) => {
    const row = db.select({ version: questions.version }).from(questions).where(eq(questions.id, questionId)).get();
    return row?.version ?? null;
  };
}

function withoutNulls(payload: Record<string, unknown>, kind: string): Record<string, unknown> {
  const keep = NULLABLE_ON_WIRE[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null && !keep.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `study_sessions.activities` is `[{type, ref_id?, count}]` with `ref_id` a UUID (data-model §5.5). The app
 * records the block key as `ref_id` and may have no block kind, so `type` is required and a non-UUID
 * `ref_id` is left out.
 */
function wireActivities(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    const activity = raw as { type?: unknown; ref_id?: unknown; count?: unknown } | null;
    if (!activity || typeof activity.type !== 'string' || activity.type.length === 0) continue;
    out.push({
      type: activity.type,
      ...(typeof activity.ref_id === 'string' && UUID_RE.test(activity.ref_id) ? { ref_id: activity.ref_id } : {}),
      count: typeof activity.count === 'number' ? Math.max(0, Math.trunc(activity.count)) : 0,
    });
  }
  return out;
}

/** The payload as the server schema for this kind expects it. */
export function toWirePayload(row: OutboxRow, ctx: WireContext): unknown {
  if (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)) return row.payload;
  const raw = row.payload as Record<string, unknown>;
  const base = withoutNulls(raw, row.kind);

  switch (row.kind) {
    case 'quiz_attempt':
      // The device that submitted the attempt is its device_id on the server.
      return { ...base, device_id: typeof raw.device_id === 'string' ? raw.device_id : ctx.deviceId };
    case 'attempt_answer': {
      // Answers carry the question version they were given against (the server grades that version).
      if (raw.question_version !== undefined || typeof raw.question_id !== 'string') return base;
      const version = ctx.questionVersion(raw.question_id);
      return version === null ? base : { ...base, question_version: version };
    }
    case 'study_session': {
      // The app's "session" is a mixed session of blocks (review, learn, practice): `mixed` on the server.
      const kind = raw.kind === 'session' ? 'mixed' : raw.kind;
      return { ...base, kind, activities: wireActivities(raw.activities) };
    }
    default:
      return base;
  }
}
