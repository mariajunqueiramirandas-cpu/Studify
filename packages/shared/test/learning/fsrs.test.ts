import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { FSRSVersion } from 'ts-fsrs';
import {
  backlogRecovery,
  canonicalReviewLogs,
  clampFutureTimestamp,
  dropCrossDeviceDoubles,
  dropUndonePairs,
  formatIntervalPt,
  isLeech,
  leechPromptOnLapse,
  newCardState,
  previewRatings,
  replayCard,
  replayReviewLogs,
  resolveParams,
  retrievability,
  scheduleReview,
  type CardState,
  type Rating,
  type ReviewLog,
} from '../../src/learning/index.ts';

const params = resolveParams();
const T0 = new Date('2026-10-27T12:00:00Z');

/** Applies a rating sequence with each review at the previous due (expected path). */
function runSequence(cardId: string, ratings: Rating[]): CardState[] {
  const states: CardState[] = [];
  let s = newCardState(cardId, T0);
  let now = T0;
  for (const r of ratings) {
    s = scheduleReview(s, r, now, params).next;
    states.push(s);
    now = s.due;
  }
  return states;
}

function logsFrom(cardId: string, ratings: Rating[], start = T0, device = 'dev-a'): ReviewLog[] {
  const logs: ReviewLog[] = [];
  let at = start;
  let s = newCardState(cardId, start);
  ratings.forEach((rating, i) => {
    logs.push({ id: `${cardId}-${String(i).padStart(3, '0')}`, cardId, rating, reviewedAt: at, deviceId: device });
    s = scheduleReview(s, rating, at, params).next;
    at = s.due;
  });
  return logs;
}

describe('pinned ts-fsrs version (§2.1, testing §3.1)', () => {
  it('is the version this engine was verified against', () => {
    expect(FSRSVersion).toContain('5.4.2');
  });
});

describe('golden schedule (testing §3.1): Good, Good, Again, Good', () => {
  // Fixtures captured from ts-fsrs 5.4.2, FSRS-6 weights, fuzz on, seeded by card id and reps.
  const golden = [
    { state: 'learning', due: '2026-10-27T12:10:00.000Z', stability: 2.3065, difficulty: 2.1181, reps: 1, lapses: 0 },
    { state: 'review', due: '2026-10-29T12:10:00.000Z', stability: 2.3065, difficulty: 2.1112, reps: 2, lapses: 0 },
    { state: 'relearning', due: '2026-10-29T12:20:00.000Z', stability: 0.6077, difficulty: 7.3922, reps: 3, lapses: 1 },
    { state: 'review', due: '2026-10-30T12:20:00.000Z', stability: 0.6598, difficulty: 7.3801, reps: 4, lapses: 1 },
  ] as const;

  it('matches the pinned fixtures for due, stability, difficulty, reps, lapses and state', () => {
    const states = runSequence('golden-1', [3, 3, 1, 3]);
    states.forEach((s, i) => {
      const want = golden[i];
      expect(want).toBeDefined();
      expect(s.state).toBe(want?.state);
      expect(s.due.toISOString()).toBe(want?.due);
      expect(s.stability).toBeCloseTo(want?.stability ?? NaN, 3);
      expect(s.difficulty).toBeCloseTo(want?.difficulty ?? NaN, 3);
      expect(s.reps).toBe(want?.reps);
      expect(s.lapses).toBe(want?.lapses);
    });
  });
});

describe('button previews (MEM-02.2)', () => {
  it('a new card previews 1 min, 6 min, 10 min, then days (Easy is fuzzed)', () => {
    const labels = previewRatings(newCardState('p1', T0), T0, params).map((p) => p.label);
    expect(labels.slice(0, 3)).toEqual(['1 min', '6 min', '10 min']);
    expect(labels[3]).toMatch(/^\d+ dias$/);
  });

  it('each preview matches the interval that scheduleReview actually applies', () => {
    const s = runSequence('p2', [3, 3])[1] as CardState;
    const at = s.due;
    for (const p of previewRatings(s, at, params)) {
      expect(scheduleReview(s, p.rating, at, params).next.due.getTime()).toBe(p.due.getTime());
    }
  });

  it('formats PT-BR interval labels', () => {
    expect(formatIntervalPt(20_000)).toBe('<1 min');
    expect(formatIntervalPt(10 * 60_000)).toBe('10 min');
    expect(formatIntervalPt(3 * 24 * 3_600_000)).toBe('3 dias');
    expect(formatIntervalPt(20 * 24 * 3_600_000)).toBe('3 sem.');
    expect(formatIntervalPt(400 * 24 * 3_600_000)).toBe('1 ano');
  });
});

describe('retrievability', () => {
  it('is null for a card that was never introduced', () => {
    expect(retrievability(newCardState('r0', T0), T0, params)).toBeNull();
  });

  it('decreases as time passes after a review', () => {
    const s = runSequence('r1', [3, 3])[1] as CardState;
    const soon = retrievability(s, new Date(s.lastReview!.getTime() + 86_400_000), params) ?? 0;
    const later = retrievability(s, new Date(s.lastReview!.getTime() + 30 * 86_400_000), params) ?? 0;
    expect(soon).toBeGreaterThan(later);
    expect(soon).toBeLessThanOrEqual(1);
    expect(later).toBeGreaterThanOrEqual(0);
  });
});

describe('leeches (MEM-02.12)', () => {
  it('is a leech at six lapses and prompts at 6, 9 and 12', () => {
    const base = newCardState('l1', T0);
    expect(isLeech({ ...base, lapses: 5 })).toBe(false);
    expect(isLeech({ ...base, lapses: 6 })).toBe(true);
    expect([6, 7, 8, 9, 10, 11, 12].filter(leechPromptOnLapse)).toEqual([6, 9, 12]);
  });
});

describe('backlog recovery (MEM-02.16, §2.4)', () => {
  it('is not offered at or below three times the daily maximum', () => {
    expect(backlogRecovery(600, 200).offered).toBe(false);
  });

  it('spreads the backlog over up to seven days', () => {
    expect(backlogRecovery(601, 200)).toEqual({ offered: true, days: 4, dailyCap: 151 });
    expect(backlogRecovery(3000, 200)).toEqual({ offered: true, days: 7, dailyCap: 429 });
  });
});

describe('offline replay and merge (ADR 0007, §2.6)', () => {
  const logs = logsFrom('rep-1', [3, 3, 1, 3, 2, 4]);

  it('replay of shuffled logs equals live scheduling of the sorted history', () => {
    const live = runSequence('rep-1', [3, 3, 1, 3, 2, 4]).at(-1) as CardState;
    fc.assert(
      fc.property(fc.shuffledSubarray(logs, { minLength: logs.length, maxLength: logs.length }), (shuffled) => {
        expect(replayCard('rep-1', shuffled, params, T0)).toEqual(live);
      }),
      { numRuns: 50 },
    );
  });

  it('replayReviewLogs replays each card independently', () => {
    const other = logsFrom('rep-2', [1, 3], T0, 'dev-b');
    const all = [...logs, ...other];
    const byCard = replayReviewLogs(all, params, T0);
    expect(byCard.get('rep-1')).toEqual(replayCard('rep-1', logs, params, T0));
    expect(byCard.get('rep-2')).toEqual(replayCard('rep-2', other, params, T0));
  });

  it('an undo pair leaves no trace in replay', () => {
    const base = logsFrom('undo-1', [3, 3]);
    const wrong: ReviewLog = { id: 'undo-target', cardId: 'undo-1', rating: 1, reviewedAt: new Date(base[1]!.reviewedAt.getTime() + 60_000), deviceId: 'dev-a' };
    const undo: ReviewLog = { id: 'undo-row', cardId: 'undo-1', rating: 1, reviewedAt: new Date(wrong.reviewedAt.getTime() + 1000), deviceId: 'dev-a', undoesLogId: 'undo-target' };
    expect(dropUndonePairs([...base, wrong, undo]).map((l) => l.id)).toEqual(base.map((l) => l.id));
    expect(replayCard('undo-1', [...base, wrong, undo], params, T0)).toEqual(replayCard('undo-1', base, params, T0));
  });

  it('drops a second device review of the same card within 60 s', () => {
    const t = new Date('2026-10-27T15:00:00Z');
    const a: ReviewLog = { id: 'a', cardId: 'x', rating: 3, reviewedAt: t, deviceId: 'phone' };
    const b: ReviewLog = { id: 'b', cardId: 'x', rating: 3, reviewedAt: new Date(t.getTime() + 30_000), deviceId: 'tablet' };
    const c: ReviewLog = { id: 'c', cardId: 'x', rating: 3, reviewedAt: new Date(t.getTime() + 61_000), deviceId: 'tablet' };
    expect(dropCrossDeviceDoubles([a, b, c]).map((l) => l.id)).toEqual(['a', 'c']);
  });

  it('keeps quick same-device sequences (legitimate learning steps)', () => {
    const t = new Date('2026-10-27T15:00:00Z');
    const a: ReviewLog = { id: 'a', cardId: 'x', rating: 1, reviewedAt: t, deviceId: 'phone' };
    const b: ReviewLog = { id: 'b', cardId: 'x', rating: 3, reviewedAt: new Date(t.getTime() + 10_000), deviceId: 'phone' };
    expect(dropCrossDeviceDoubles([a, b]).map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('clamps a log more than 5 minutes ahead of server receipt to receipt time', () => {
    const receivedAt = new Date('2026-10-27T15:00:00Z');
    const future: ReviewLog = {
      id: 'skew',
      cardId: 'x',
      rating: 3,
      reviewedAt: new Date(receivedAt.getTime() + 3 * 86_400_000),
      deviceId: 'phone',
      receivedAt,
    };
    expect(clampFutureTimestamp(future).reviewedAt.getTime()).toBe(receivedAt.getTime());
    const nearby = { ...future, reviewedAt: new Date(receivedAt.getTime() + 4 * 60_000) };
    expect(clampFutureTimestamp(nearby).reviewedAt.getTime()).toBe(nearby.reviewedAt.getTime());
  });

  it('canonicalReviewLogs is stable under permutation', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(logs, { minLength: logs.length, maxLength: logs.length }), (shuffled) => {
        expect(canonicalReviewLogs(shuffled).map((l) => l.id)).toEqual(logs.map((l) => l.id));
      }),
      { numRuns: 30 },
    );
  });
});

describe('properties (testing §3.1, fast-check)', () => {
  const ratingArb = fc.constantFrom<Rating>(1, 2, 3, 4);
  const historyArb = fc.array(fc.record({ rating: ratingArb, gapMinutes: fc.integer({ min: 1, max: 60 * 24 * 10 }) }), {
    minLength: 1,
    maxLength: 25,
  });

  it('due is always after the review time, and stability never goes negative', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        let s = newCardState('prop-due', T0);
        let now = T0;
        for (const step of history) {
          now = new Date(now.getTime() + step.gapMinutes * 60_000);
          const next = scheduleReview(s, step.rating, now, params).next;
          expect(next.due.getTime()).toBeGreaterThan(now.getTime());
          expect(next.stability).toBeGreaterThanOrEqual(0);
          s = next;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Again never yields a longer interval than Good on the same state', () => {
    fc.assert(
      fc.property(historyArb, (history) => {
        let s = newCardState('prop-again', T0);
        let now = T0;
        for (const step of history) {
          now = new Date(now.getTime() + step.gapMinutes * 60_000);
          s = scheduleReview(s, step.rating, now, params).next;
        }
        const preview = previewRatings(s, s.due, params);
        const again = preview.find((p) => p.rating === 1)!;
        const good = preview.find((p) => p.rating === 3)!;
        expect(again.intervalMs).toBeLessThanOrEqual(good.intervalMs);
      }),
      { numRuns: 200 },
    );
  });
});
