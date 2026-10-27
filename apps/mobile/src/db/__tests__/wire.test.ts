// Outbox payloads as the app writes them -> the sync-push wire contract (sync/wire.ts).
import type { OutboxRow } from '../outbox';
import { toWirePayload, type WireContext } from '../sync/wire';

const ctx: WireContext = { deviceId: 'device-7', questionVersion: (id) => (id === 'q-known' ? 3 : null) };

function row(kind: string, payload: unknown): OutboxRow {
  return { id: '0190a000-0000-7000-8000-000000000001', kind, entityId: null, payload, schemaVersion: 1, createdAt: 0, attempts: 0, lastError: null } as OutboxRow;
}

describe('toWirePayload', () => {
  it('drops nulls the schema does not accept (duration_ms, confidence) but keeps the nullable ones', () => {
    const review = toWirePayload(row('review_log', { card_id: 'c', rating: 3, duration_ms: null, reviewed_at: 'x' }), ctx) as Record<string, unknown>;
    expect(review).not.toHaveProperty('duration_ms');
    expect(review.card_id).toBe('c');

    const attempt = toWirePayload(row('quiz_attempt', { quiz_id: 'q', status: 'submitted', finished_at: null }), ctx) as Record<string, unknown>;
    expect(attempt.finished_at).toBeNull();
  });

  it('stores a quiz attempt with the device that submitted it', () => {
    expect((toWirePayload(row('quiz_attempt', { quiz_id: 'q', status: 'submitted' }), ctx) as Record<string, unknown>).device_id).toBe('device-7');
  });

  it('sends the local question version with each attempt answer, and leaves it out when the question is unknown', () => {
    const known = toWirePayload(row('attempt_answer', { attempt_id: 'a', question_id: 'q-known', response: 'A', confidence: null }), ctx) as Record<string, unknown>;
    expect(known.question_version).toBe(3);
    expect(known).not.toHaveProperty('confidence');
    const unknown = toWirePayload(row('attempt_answer', { attempt_id: 'a', question_id: 'q-other' }), ctx) as Record<string, unknown>;
    expect(unknown).not.toHaveProperty('question_version');
  });

  it('maps the app session to a mixed study session and keeps only well-formed activities', () => {
    const session = toWirePayload(
      row('study_session', {
        kind: 'session',
        activities: [
          { type: 'review', ref_id: 'review', count: 1 },
          { type: 'learn', ref_id: '0190a000-0000-7000-8000-0000000000aa', count: 2 },
          { ref_id: 'practice', count: 1 },
        ],
      }),
      ctx,
    ) as Record<string, unknown>;
    expect(session.kind).toBe('mixed');
    expect(session.activities).toEqual([
      { type: 'review', count: 1 },
      { type: 'learn', ref_id: '0190a000-0000-7000-8000-0000000000aa', count: 2 },
    ]);
  });

  it('leaves the payloads of other kinds as they are, minus the nulls', () => {
    const payload = { note_id: 'n', start: 0, end: 4, quote: 'abc', color: 'yellow', deleted_at: null, updated_at: 'x' };
    expect(toWirePayload(row('note_highlight', payload), ctx)).toEqual(payload);
  });
});
