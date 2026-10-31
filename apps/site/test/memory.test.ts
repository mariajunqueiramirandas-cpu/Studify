import { describe, expect, test } from 'vitest';
import { firstRead, formatSpan, newCardRatings, planCurve, recall, retrievability } from '../src/memory.ts';

describe('the memory model', () => {
  test('material read once fades on the FSRS curve: 90% after one stability, then lower and lower', () => {
    const read = firstRead(0);
    expect(retrievability(read, 0)).toBe(1);
    expect(retrievability(read, read.stability * 24)).toBeCloseTo(0.9, 5);
    const later = [10, 30, 60, 120].map((h) => retrievability(read, h));
    expect(later).toEqual([...later].sort((a, b) => b - a));
    expect(later[3]).toBeLessThan(0.7);
  });

  test('with no trace there is nothing to forget', () => {
    expect(retrievability(null, 1000)).toBe(1);
  });

  test('remembering grows stability, more when it was harder; missing shrinks it', () => {
    const read = firstRead(0);
    const early = recall(read, 5, true);
    const late = recall(read, 100, true);
    expect(early.stability).toBeGreaterThan(read.stability);
    expect(late.stability).toBeGreaterThan(early.stability);
    expect(recall(read, 100, false).stability).toBeLessThan(read.stability);
    expect(late.at).toBe(100);
  });

  test('spans read like the app', () => {
    expect(formatSpan(0.5)).toBe('30 min');
    expect(formatSpan(1)).toBe('1 hora');
    expect(formatSpan(48)).toBe('2 dias');
    expect(formatSpan(24 * 90)).toBe('3 meses');
    expect(formatSpan(24 * 365 * 20)).toBe('20 anos');
  });
});

describe('the flashcard and the plan', () => {
  test('the rating keys show what the app schedules for a new card', () => {
    expect(newCardRatings().map((k) => `${k.label} ${k.interval}`)).toEqual(['Errei 1 min', 'Difícil 6 min', 'Bom 10 min', 'Fácil 8 dias']);
  });

  test('reviews land before the exam, the last one on the eve, and keep memory above reading once', () => {
    for (const days of [3, 7, 12, 30]) {
      const plan = planCurve(days);
      expect(plan.reviews.at(-1)).toBe(days - 1);
      expect(plan.reviews).toEqual([...plan.reviews].sort((a, b) => a - b));
      expect(plan.atExam.withReviews).toBeGreaterThan(0.9);
      expect(plan.atExam.readOnly).toBeLessThan(plan.atExam.withReviews);
      expect(plan.readOnly.at(-1)?.[0]).toBeCloseTo(days, 5);
    }
  });
});
