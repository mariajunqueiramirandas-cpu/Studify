import { describe, expect, it } from 'vitest';
import { brierScore, calibration, expectedConfidence, type RatedAnswer } from '../../src/learning/index.ts';

const T = new Date('2026-10-27T12:00:00Z');

function answer(over: Partial<RatedAnswer> & { bucketId: string }): RatedAnswer {
  return { confidence: 3, score: 1, numOptions: 4, trueFalse: false, answeredAt: T, ...over };
}

describe('expected confidence (§8)', () => {
  it('level 1 is chance (1/options, 0.5 for true/false); levels 2–4 are fixed', () => {
    expect(expectedConfidence(1, 4, false)).toBe(0.25);
    expect(expectedConfidence(1, 2, true)).toBe(0.5);
    expect(expectedConfidence(2, 4, false)).toBe(0.55);
    expect(expectedConfidence(3, 4, false)).toBe(0.75);
    expect(expectedConfidence(4, 4, false)).toBe(0.95);
  });
});

describe('Brier score (§8, hand-computed)', () => {
  it('mean of squared errors: [(0.75−1)², (0.75−0)²] → 0.3125', () => {
    expect(brierScore([{ expected: 0.75, score: 1 }, { expected: 0.75, score: 0 }])).toBeCloseTo(0.3125, 12);
  });

  it('perfect calibration on certain answers is zero; no pairs is null', () => {
    expect(brierScore([{ expected: 1, score: 1 }, { expected: 0, score: 0 }])).toBe(0);
    expect(brierScore([])).toBeNull();
  });

  it('matches the report overall figure', () => {
    const rows = [answer({ bucketId: 'a', confidence: 4, score: 1 }), answer({ bucketId: 'a', confidence: 4, score: 0 })];
    const report = calibration(rows);
    expect(report.overall.brier).toBeCloseTo(((0.95 - 1) ** 2 + (0.95 - 0) ** 2) / 2, 12);
  });
});

describe('buckets and insights (§8, n ≥ 10)', () => {
  it('flags a topic as overconfident when mean(expected) − accuracy ≥ 0.15 with n ≥ 10', () => {
    // Confidence 4 (expected 0.95) with 30% accuracy: gap 0.65.
    const rows = Array.from({ length: 10 }, (_, i) => answer({ bucketId: 'hard', confidence: 4, score: i < 3 ? 1 : 0 }));
    const report = calibration(rows);
    expect(report.buckets[0]).toMatchObject({ bucketId: 'hard', state: 'overconfident' });
    expect(report.insights.map((b) => b.bucketId)).toEqual(['hard']);
  });

  it('buckets below 10 answers have no insight', () => {
    const rows = Array.from({ length: 9 }, (_, i) => answer({ bucketId: 'small', confidence: 4, score: i < 1 ? 1 : 0 }));
    const report = calibration(rows);
    expect(report.buckets[0]?.state).toBe('insufficient');
    expect(report.insights).toEqual([]);
  });

  it('underconfident buckets are flagged at gap ≤ −0.15', () => {
    // Confidence 2 (expected 0.55) with 100% accuracy: gap −0.45.
    const rows = Array.from({ length: 10 }, () => answer({ bucketId: 'easy', confidence: 2, score: 1 }));
    expect(calibration(rows).buckets[0]?.state).toBe('underconfident');
  });

  it('shows at most two insights, largest gap first', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => answer({ bucketId: 'a', confidence: 4, score: 0 })),
      ...Array.from({ length: 10 }, () => answer({ bucketId: 'b', confidence: 4, score: 0.5 })),
      ...Array.from({ length: 10 }, () => answer({ bucketId: 'c', confidence: 2, score: 1 })),
    ];
    const insights = calibration(rows).insights;
    expect(insights).toHaveLength(2);
    expect(insights[0]?.bucketId).toBe('a');
  });

  it('reliability bins cover levels 1 to 4', () => {
    const report = calibration([answer({ bucketId: 'x', confidence: 1, score: 1 })]);
    expect(report.reliability.map((b) => [b.level, b.n])).toEqual([[1, 1], [2, 0], [3, 0], [4, 0]]);
  });
});

describe('"bem calibrado" achievement (§8)', () => {
  it('needs 50 rated answers, and |gap| ≤ 0.10 over the last 50', () => {
    const fifty = (correct: number): RatedAnswer[] =>
      Array.from({ length: 50 }, (_, i) => answer({ bucketId: 'k', confidence: 3, score: i < correct ? 1 : 0, answeredAt: new Date(T.getTime() + i * 60_000) }));
    expect(calibration(fifty(38)).calibrated).toBe(true); // accuracy 0.76 vs expected 0.75
    expect(calibration(fifty(30)).calibrated).toBe(false); // gap 0.15
    expect(calibration(fifty(38).slice(0, 49)).calibrated).toBe(false);
  });
});
