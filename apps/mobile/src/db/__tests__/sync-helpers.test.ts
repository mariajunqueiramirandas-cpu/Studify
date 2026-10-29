/// <reference types="jest" />
jest.mock('expo-sqlite', () => require('../testing/expo-sqlite.mock'));

import { filterSignature } from '../sync/engine';
import { parseInstantMs } from '../sync/clock';
import { serverRowToValues, keyValues, selectColumnsFor } from '../sync/mapping';
import { planWindowAround, PULL_TABLES } from '../sync/registry';
import { cardStates, cards } from '../schema';

describe('filterSignature', () => {
  it('is stable for the same scope regardless of value order', () => {
    expect(filterSignature([{ column: 'subject_id', op: 'in', value: ['b', 'a'] }])).toBe(
      filterSignature([{ column: 'subject_id', op: 'in', value: ['a', 'b'] }]),
    );
  });
});

describe('parseInstantMs', () => {
  it('reads Postgres microsecond timestamps with a +00:00 offset', () => {
    expect(parseInstantMs('2026-10-27T10:00:00.123456+00:00')).toBe(Date.parse('2026-10-27T10:00:00.123Z'));
    expect(parseInstantMs('2026-10-27T10:00:00Z')).toBe(Date.parse('2026-10-27T10:00:00Z'));
  });
});

describe('serverRowToValues', () => {
  it('maps snake_case rows to camelCase values with Dates for instants', () => {
    const values = serverRowToValues(
      cardStates,
      {
        user_id: 'u1',
        card_id: 'c1',
        subject_id: 's1',
        due: '2026-10-28T10:00:00.000500+00:00',
        stability: 2.5,
        difficulty: 4,
        elapsed_days: 0,
        scheduled_days: 1,
        reps: 1,
        lapses: 0,
        state: 1,
        learning_steps: 0,
        last_review: null,
        suspended: false,
        hidden: false,
        is_leech: false,
        introduced_at: null,
        last_log_id: 'l1',
        updated_at: '2026-10-27T10:00:00.000500+00:00',
      },
      new Date(0),
    );
    expect(values['due']).toBeInstanceOf(Date);
    expect((values['due'] as Date).getTime()).toBe(Date.parse('2026-10-28T10:00:00.000Z'));
    expect(values['cardId']).toBe('c1');
    expect(values['pulledAt']).toEqual(new Date(0));
    expect(values['lastReview']).toBeNull();
  });

  it('selects every mirrored column except local bookkeeping, and keeps the key order', () => {
    const select = selectColumnsFor(cards);
    expect(select).toContain('subject_id');
    expect(select).not.toContain('_pulled_at');
    expect(keyValues({ a: 'x', b: 2 }, ['a', 'b'])).toEqual(['x', 2]);
  });

  it('registers every pull table once, parents before children', () => {
    const names = PULL_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.indexOf('subjects')).toBeLessThan(names.indexOf('cards'));
    expect(names.indexOf('cards')).toBeLessThan(names.indexOf('card_states'));
  });

  it('builds a ±7 day plan window around a local date', () => {
    expect(planWindowAround('2026-10-27')).toEqual({ from: '2026-10-20', to: '2026-11-03' });
  });
});
