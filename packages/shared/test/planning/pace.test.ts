import { describe, expect, it } from 'vitest';
import { estLearnMinutes, learnPace, reviewSecondsFrom, type PaceSample } from '../../src/planning/index.ts';

const sample = (subjectId: string, planned: number, actual: number, at: number): PaceSample => ({ subjectId, plannedMinutes: planned, actualMinutes: actual, at });

describe('learnPace (spec 07 §8.2.1)', () => {
  it('stays 1 until the student has 3 finished learn blocks', () => {
    expect(learnPace([sample('fis', 20, 40, 1), sample('fis', 20, 40, 2)]).overall).toBe(1);
  });

  it('follows a slow subject with an EMA and keeps a fast one apart', () => {
    const slow = [1, 2, 3, 4, 5].map((i) => sample('fis', 20, 36, i));
    const fast = [6, 7, 8].map((i) => sample('his', 30, 18, i));
    const pace = learnPace([...slow, ...fast]);
    expect(pace.bySubject.get('fis')).toBeGreaterThan(1.3);
    expect(pace.bySubject.get('his')).toBeLessThan(0.9);
  });

  it('uses the overall pace for a subject with few sessions, and clamps outliers', () => {
    const pace = learnPace([sample('a', 10, 15, 1), sample('a', 10, 15, 2), sample('a', 10, 15, 3), sample('b', 10, 400, 4)]);
    expect(pace.bySubject.get('b')).toBe(pace.overall);
    expect(pace.overall).toBeLessThanOrEqual(2);
  });
});

describe('reviewSecondsFrom', () => {
  it('is the median of usable review durations, with a fallback when there are few', () => {
    expect(reviewSecondsFrom([5_000, 6_000], 8)).toBe(8);
    const durations = [...Array(30).fill(12_000), 500, 300_000];
    expect(reviewSecondsFrom(durations, 8)).toBe(12);
  });
});

describe('estLearnMinutes with model estimates', () => {
  it('uses the estimate for sources that have one and the page formula for the rest', () => {
    expect(estLearnMinutes([{ kind: 'slides', pages: 10 }])).toBe(15);
    expect(estLearnMinutes([{ kind: 'slides', pages: 10, minutes: 40 }, { kind: 'notes', pages: 2 }])).toBe(46);
    expect(estLearnMinutes([{ kind: 'textbook', pages: 60 }])).toBe(90);
    expect(estLearnMinutes([{ kind: 'textbook', pages: 60, minutes: 150 }])).toBe(150);
  });
});
