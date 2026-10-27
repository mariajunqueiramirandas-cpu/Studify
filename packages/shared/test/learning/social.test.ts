import { describe, expect, it } from 'vitest';
import {
  battlePoints,
  classInsightDisplay,
  duelAnswerSeconds,
  duelPoints,
  isBattleAnswerRejected,
  isDuelTimeout,
  topicInsight,
} from '../../src/learning/index.ts';

describe('duel scoring (§18.1, SOC-02)', () => {
  it('correct: 100 + round(50·(1 − t/T)); wrong: 0', () => {
    expect(duelPoints(true, 0, 30)).toBe(150);
    expect(duelPoints(true, 15, 30)).toBe(125);
    expect(duelPoints(true, 30, 30)).toBe(100);
    expect(duelPoints(false, 0, 30)).toBe(0);
  });

  it('time is clamped to [0, T]', () => {
    expect(duelPoints(true, -5, 30)).toBe(150);
    expect(duelPoints(true, 90, 30)).toBe(100);
  });

  it('server-measured answer time subtracts 0.5 s and is clamped', () => {
    expect(duelAnswerSeconds(0, 5000)).toBeCloseTo(4.5, 10);
    expect(duelAnswerSeconds(5000, 1000)).toBe(0);
    expect(duelAnswerSeconds(0, 120_000)).toBe(30);
  });

  it('answers after the deadline plus 3 s are timeouts', () => {
    expect(isDuelTimeout(4000, 1000)).toBe(false);
    expect(isDuelTimeout(4001, 1000)).toBe(true);
  });
});

describe('battle scoring (§18.2, SOC-03)', () => {
  it('base 500–1000 when correct, from fastest to slowest; zero when wrong', () => {
    expect(battlePoints(true, 0, 30, 1)).toBe(1000);
    expect(battlePoints(true, 30, 30, 1)).toBe(500);
    expect(battlePoints(true, 15, 30, 1)).toBe(750);
    expect(battlePoints(false, 0, 30, 4)).toBe(0);
  });

  it('streak bonus: 50 per answer beyond the first, capped at 200', () => {
    expect(battlePoints(true, 0, 30, 1)).toBe(1000);
    expect(battlePoints(true, 0, 30, 3)).toBe(1100);
    expect(battlePoints(true, 0, 30, 10)).toBe(1200);
  });

  it('answers after closes_at + 1 s are rejected', () => {
    expect(isBattleAnswerRejected(2001, 1000)).toBe(true);
    expect(isBattleAnswerRejected(2000, 1000)).toBe(false);
  });
});

describe('class insights: k-anonymity with k = 5 (§18.3, SOC-04)', () => {
  it('fewer than five answerers reveal nothing', () => {
    expect(classInsightDisplay({ answerers: 4, wrong: 4 }).display).toEqual({ kind: 'none' });
  });

  it('5–9 answerers, or fewer than two right or wrong, show only a band', () => {
    expect(classInsightDisplay({ answerers: 7, wrong: 5 }).display).toEqual({ kind: 'band', band: 'hard', label: 'Difícil para a turma' });
    expect(classInsightDisplay({ answerers: 7, wrong: 1 }).display).toEqual({ kind: 'band', band: 'easy', label: 'Tranquila para a turma' });
    expect(classInsightDisplay({ answerers: 7, wrong: 3 }).display).toEqual({ kind: 'none' });
    expect(classInsightDisplay({ answerers: 20, wrong: 0 }).display).toEqual({ kind: 'band', band: 'easy', label: 'Tranquila para a turma' });
  });

  it('10 or more with at least two right and two wrong: error rate rounded to 5% and clamped to [5%, 95%]', () => {
    expect(classInsightDisplay({ answerers: 20, wrong: 7 }).display).toEqual({ kind: 'error_rate', errorRate: 0.35 });
    expect(classInsightDisplay({ answerers: 50, wrong: 48 }).display).toEqual({ kind: 'error_rate', errorRate: 0.95 });
    expect(classInsightDisplay({ answerers: 100, wrong: 60 }).display).toEqual({ kind: 'error_rate', errorRate: 0.6 });
  });

  it('a pitfall (wrong option) needs three choosers and ten answerers', () => {
    expect(classInsightDisplay({ answerers: 20, wrong: 7, topWrongOptionCount: 3 }).pitfallRate).toBe(0.15);
    expect(classInsightDisplay({ answerers: 20, wrong: 7, topWrongOptionCount: 2 }).pitfallRate).toBeNull();
    expect(classInsightDisplay({ answerers: 8, wrong: 4, topWrongOptionCount: 3 }).pitfallRate).toBeNull();
  });

  it('topic aggregate: mean error over questions with n ≥ 5, only with at least three such questions', () => {
    const qs = [
      { answerers: 5, wrong: 1 },
      { answerers: 10, wrong: 4 },
      { answerers: 10, wrong: 6 },
      { answerers: 3, wrong: 3 },
    ];
    expect(topicInsight(qs)).toEqual({ kind: 'error_rate', errorRate: 0.4 });
    expect(topicInsight(qs.slice(0, 2))).toEqual({ kind: 'none' });
  });
});
