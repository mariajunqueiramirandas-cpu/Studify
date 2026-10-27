import { describe, expect, it } from 'vitest';
import {
  AttemptAnswerPayloadSchema,
  BattleControlReqSchema,
  CardDraftResSchema,
  DuelNextResSchema,
  IngestStartReqSchema,
  InviteCodeSchema,
  OutboxItemSchema,
  ProfileSettingsSchema,
  QuizCreateReqSchema,
  SYNC_PUSH_MAX_ITEMS,
  SYNC_SCHEMA_VERSION,
  SseEventSchema,
  SyncPushReqSchema,
  SyncPushResSchema,
  TutorChatReqSchema,
  TutorScopeSchema,
  isSupportedSyncSchemaVersion,
  parseProfileSettings,
  rpcArgsSchema,
  rpcResultSchema,
  SYNC_OUTBOX_KINDS,
} from '../../src/core/schemas/index.ts';
import { uuidV7 } from '../../src/core/ids.ts';

const V4 = '4f6c2a1e-9b3d-4c5e-8f70-1a2b3c4d5e6f';
const CARD = '0190f3b2-7c4d-7a1b-8c2d-3e4f5a6b7c8d';
const SUBJECT = '0190f3b2-7c4d-7a1b-8c2d-3e4f5a6b7c90';
const NOW = '2026-10-27T12:00:00Z';

function reviewItem(id: string = uuidV7()) {
  return {
    id,
    kind: 'review_log' as const,
    payload: { card_id: CARD, rating: 3, reviewed_at: NOW, client_reviewed_at: NOW },
    created_at: NOW,
  };
}

describe('sync protocol', () => {
  it('exposes schema version 1 and the outbox kinds of api §4.1', () => {
    expect(SYNC_SCHEMA_VERSION).toBe(1);
    expect(isSupportedSyncSchemaVersion(1)).toBe(true);
    expect(isSupportedSyncSchemaVersion(2)).toBe(false); // newer than this server → 426
    expect(isSupportedSyncSchemaVersion(0)).toBe(false);
    expect(SYNC_OUTBOX_KINDS).toContain('subject_user_setting');
    expect(SYNC_OUTBOX_KINDS).toHaveLength(17);
  });

  it('accepts a valid review_log push', () => {
    const req = { schema_version: 1, device_id: 'dev-1', items: [reviewItem()] };
    expect(SyncPushReqSchema.safeParse(req).success).toBe(true);
  });

  it('accepts exactly 200 rows and rejects 201', () => {
    const items = Array.from({ length: SYNC_PUSH_MAX_ITEMS }, () => reviewItem());
    expect(SyncPushReqSchema.safeParse({ schema_version: 1, device_id: 'd', items }).success).toBe(true);
    const tooMany = [...items, reviewItem()];
    expect(SyncPushReqSchema.safeParse({ schema_version: 1, device_id: 'd', items: tooMany }).success).toBe(false);
  });

  it('rejects an empty batch and non-v7 outbox ids', () => {
    expect(SyncPushReqSchema.safeParse({ schema_version: 1, device_id: 'd', items: [] }).success).toBe(false);
    expect(SyncPushReqSchema.safeParse({ schema_version: 1, device_id: 'd', items: [reviewItem(V4)] }).success).toBe(false);
  });

  it('rejects an unknown kind and a rating outside 1–4', () => {
    const unknownKind = { ...reviewItem(), kind: 'mystery' };
    expect(OutboxItemSchema.safeParse(unknownKind).success).toBe(false);
    const badRating = reviewItem();
    badRating.payload.rating = 5;
    expect(OutboxItemSchema.safeParse(badRating).success).toBe(false);
  });

  it('checks each payload against the schema of its own kind', () => {
    const planStatusNoChange = {
      id: uuidV7(),
      kind: 'plan_item_status',
      payload: { plan_item_id: CARD, updated_at: NOW },
      created_at: NOW,
    };
    expect(OutboxItemSchema.safeParse(planStatusNoChange).success).toBe(false);
    const planStatusOk = { ...planStatusNoChange, payload: { plan_item_id: CARD, status: 'done', updated_at: NOW } };
    expect(OutboxItemSchema.safeParse(planStatusOk).success).toBe(true);
  });

  it('attempt answers need a time spent and a confidence in 1–4 when present', () => {
    const base = {
      attempt_id: CARD,
      question_id: SUBJECT,
      question_version: 1,
      time_spent_ms: 4200,
      answered_at: NOW,
    };
    expect(AttemptAnswerPayloadSchema.safeParse({ ...base, confidence: 4 }).success).toBe(true);
    expect(AttemptAnswerPayloadSchema.safeParse({ ...base, confidence: 5 }).success).toBe(false);
  });

  it('parses the ack with authoritative card states and rejects unknown reject codes', () => {
    const ack = {
      acked: [uuidV7()],
      rejected: [{ id: uuidV7(), code: 'stale', drop: false }],
      card_states: [
        {
          card_id: CARD,
          due: NOW,
          stability: 2.3,
          difficulty: 5.1,
          elapsed_days: 0,
          scheduled_days: 3,
          reps: 2,
          lapses: 0,
          state: 2,
          learning_steps: 0,
          last_review: NOW,
          suspended: false,
          hidden: false,
          is_leech: false,
          introduced_at: NOW,
          updated_at: NOW,
        },
      ],
      server_time: NOW,
    };
    expect(SyncPushResSchema.safeParse(ack).success).toBe(true);
    expect(SyncPushResSchema.safeParse({ ...ack, rejected: [{ id: uuidV7(), code: 'maybe', drop: true }] }).success).toBe(false);
  });
});

describe('profile settings', () => {
  it('fills defaults from data-model §5.1 and merges partial nested objects', () => {
    const s = parseProfileSettings({ notifications: { reviews: false } });
    expect(s.theme).toBe('system');
    expect(s.daily_goal_minutes).toBe(20);
    expect(s.notifications).toEqual({ reviews: false, plan: true, class: true, processing: true });
    expect(s.memory?.desired_retention).toBe(0.9);
    expect(s.feed?.bedtime).toBe('23:00');
  });

  it('rejects an invalid stored value', () => {
    expect(() => parseProfileSettings({ theme: 'neon' })).toThrow();
    expect(ProfileSettingsSchema.safeParse({ storage_quota_mb: 750 }).success).toBe(false);
  });
});

describe('tutor scope and chat request', () => {
  it('requires the id that matches the scope type', () => {
    expect(TutorScopeSchema.safeParse({ type: 'subject' }).success).toBe(false);
    expect(TutorScopeSchema.safeParse({ type: 'subject', subject_id: SUBJECT }).success).toBe(true);
    expect(TutorScopeSchema.safeParse({ type: 'topic', subject_id: SUBJECT }).success).toBe(false);
  });

  it('a new thread needs a scope; a message is capped at 4,000 characters', () => {
    const base = { mode: 'answer', client_message_id: uuidV7(), message: 'Oi' };
    expect(TutorChatReqSchema.safeParse(base).success).toBe(false);
    expect(TutorChatReqSchema.safeParse({ ...base, scope: { type: 'subject', subject_id: SUBJECT } }).success).toBe(true);
    expect(
      TutorChatReqSchema.safeParse({ ...base, thread_id: CARD, message: 'x'.repeat(4001) }).success,
    ).toBe(false);
  });
});

describe('Edge Function payloads', () => {
  it('invite codes exclude 0, O, 1 and I (security §9)', () => {
    expect(InviteCodeSchema.safeParse('ABCDEFGH').success).toBe(true);
    expect(InviteCodeSchema.safeParse('ABCD0OIL').success).toBe(false);
    expect(InviteCodeSchema.safeParse('ABCDEFG').success).toBe(false);
  });

  it('ingest-start needs a document id and an optional mode', () => {
    expect(IngestStartReqSchema.safeParse({ document_id: CARD }).success).toBe(true);
    expect(IngestStartReqSchema.safeParse({ document_id: CARD, mode: 'partial' }).success).toBe(false);
    expect(IngestStartReqSchema.safeParse({ document_id: 'x' }).success).toBe(false);
  });

  it('quiz-create accepts 5–90 questions', () => {
    const base = { kind: 'practice', scope: { subject_id: SUBJECT }, mode: 'practice' };
    expect(QuizCreateReqSchema.safeParse({ ...base, count: 5 }).success).toBe(true);
    expect(QuizCreateReqSchema.safeParse({ ...base, count: 4 }).success).toBe(false);
    expect(QuizCreateReqSchema.safeParse({ ...base, kind: 'enem_simulado', count: 10 }).success).toBe(false);
  });

  it('card drafts are basic or cloze only', () => {
    const draft = { front: 'Q', back: 'A', source_pages: [{ document_id: CARD, page_start: 2, page_end: 3 }] };
    expect(CardDraftResSchema.safeParse({ ...draft, type: 'cloze' }).success).toBe(true);
    expect(CardDraftResSchema.safeParse({ ...draft, type: 'image_occlusion' }).success).toBe(false);
  });

  it('duel-next answers with a question or a finished marker', () => {
    const question = { id: CARD, type: 'mcq_single', stem: 'Qual?', payload: {} };
    expect(
      DuelNextResSchema.safeParse({ index: 0, total: 5, question, deadline_at: NOW }).success,
    ).toBe(true);
    expect(DuelNextResSchema.safeParse({ finished: true }).success).toBe(true);
    expect(DuelNextResSchema.safeParse({ finished: false }).success).toBe(false);
  });

  it('battle-control is a discriminated union on action; counts are 5, 10 or 15', () => {
    const create = { action: 'create', class_group_id: CARD, subject_id: SUBJECT, count: 10 };
    expect(BattleControlReqSchema.safeParse(create).success).toBe(true);
    expect(BattleControlReqSchema.safeParse({ ...create, count: 7 }).success).toBe(false);
    expect(BattleControlReqSchema.safeParse({ action: 'next', battle_id: CARD }).success).toBe(true);
    expect(BattleControlReqSchema.safeParse({ action: 'pause', battle_id: CARD }).success).toBe(false);
  });
});

describe('SSE events (api §2.6)', () => {
  it('accepts delta, citation and done events', () => {
    expect(SseEventSchema.safeParse({ event: 'delta', data: { text: 'Olá' } }).success).toBe(true);
    expect(
      SseEventSchema.safeParse({
        event: 'citation',
        data: { index: 0, start: 0, end: 4, document_id: CARD, page_start: 14, page_end: 14, cited_text: 'Mitose' },
      }).success,
    ).toBe(true);
    expect(
      SseEventSchema.safeParse({ event: 'done', data: { stop_reason: 'end_turn', usage_pct_today: 42 } }).success,
    ).toBe(true);
  });

  it('usage is a percentage between 0 and 100, never dollars', () => {
    expect(
      SseEventSchema.safeParse({ event: 'done', data: { stop_reason: 'end_turn', usage_pct_today: 101 } }).success,
    ).toBe(false);
  });
});

describe('RPC registry (api §5)', () => {
  it('validates args of edit_outline: merge needs at least two nodes', () => {
    const args = (ops: unknown[]) => ({ subject_id: SUBJECT, ops });
    const schema = rpcArgsSchema('edit_outline');
    expect(schema.safeParse(args([{ op: 'merge', node_ids: [CARD], title: 'x' }])).success).toBe(false);
    expect(schema.safeParse(args([{ op: 'merge', node_ids: [CARD, SUBJECT], title: 'x' }])).success).toBe(true);
  });

  it('start_desperate_mode bounds minutes per day to 60–240', () => {
    const schema = rpcArgsSchema('start_desperate_mode');
    const base = { goal_id: CARD, exam_ids: [SUBJECT] };
    expect(schema.safeParse({ ...base, minutes_per_day: 59 }).success).toBe(false);
    expect(schema.safeParse({ ...base, minutes_per_day: 240 }).success).toBe(true);
  });

  it('void RPCs resolve to null', () => {
    expect(rpcResultSchema('undo_outline_event').safeParse(null).success).toBe(true);
    expect(rpcResultSchema('undo_outline_event').safeParse({}).success).toBe(false);
  });
});
