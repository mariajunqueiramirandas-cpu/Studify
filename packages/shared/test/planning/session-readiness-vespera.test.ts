import { describe, expect, it } from 'vitest';
import {
  buildSession,
  buildVespera,
  fitGradeMapping,
  notifyTime,
  planDaysUntil,
  planStudyDayOf,
  predictedGrade,
  readiness,
  sleepStopTime,
  type PredictionTopic,
  type SessionInput,
} from '../../src/planning/index.ts';

const reviews = (n: number, inScope = true) =>
  Array.from({ length: n }, (_, i) => ({ cardId: `c${String(i).padStart(3, '0')}`, inScope, overdueDays: n - i }));

describe('GOL-05 session builder (§12)', () => {
  const base: SessionInput = {
    dueReviews: [],
    planItems: [],
    topics: [],
  };

  it('with T ≤ 10 it plans reviews only', () => {
    const s = buildSession({ ...base, dueReviews: reviews(100), planItems: [{ id: 'p1', unitType: 'learn', topicId: 'A', minutes: 20, orderInDay: 0, status: 'planned' }] }, 10);
    expect(s.blocks.every((b) => b.kind === 'reviews')).toBe(true);
    expect(s.totalMinutes).toBeLessThanOrEqual(10);
  });

  it('reviews take at most 40% of T, in-scope cards first', () => {
    const due = [...reviews(3, false), ...reviews(200, true).map((c, i) => ({ ...c, cardId: `s${i}` }))];
    const s = buildSession(
      { ...base, dueReviews: due, reviewSeconds: 10, planItems: [{ id: 'p1', unitType: 'practice', topicId: 'A', minutes: 40, orderInDay: 0, status: 'planned' }] },
      30,
    );
    const first = s.blocks[0];
    expect(first?.kind).toBe('reviews');
    if (first?.kind === 'reviews') {
      expect(first.cardIds.length).toBe(72); // 0.4 × 30 min = 12 min = 72 cards at 10 s
      expect(first.cardIds[0]?.startsWith('s')).toBe(true);
      expect(first.minutes).toBe(12);
    }
  });

  it('adds a 3–5 question retrieval check after a learn block and closes with a recap', () => {
    const s = buildSession(
      {
        ...base,
        planItems: [{ id: 'l1', unitType: 'learn', topicId: 'A', minutes: 20, orderInDay: 0, status: 'planned' }],
        newCardsFirstSeen: ['x1', 'x2'],
      },
      30,
    );
    const kinds = s.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['plan_item', 'retrieval', 'recap']);
    const retrieval = s.blocks[1];
    if (retrieval?.kind === 'retrieval') expect(retrieval.questionCount).toBeGreaterThanOrEqual(3);
  });

  it('truncates the item that does not fit, keeping at least 10 minutes', () => {
    const s = buildSession(
      { ...base, planItems: [{ id: 'l1', unitType: 'learn', topicId: 'A', minutes: 50, orderInDay: 0, status: 'planned' }] },
      20,
    );
    const item = s.blocks.find((b) => b.kind === 'plan_item');
    expect(item?.kind === 'plan_item' && item.truncated).toBe(true);
  });

  it('nothing planned: due reviews, then the weakest-topic quiz, then "zerou o dia"', () => {
    const withDue = buildSession({ ...base, dueReviews: reviews(5) }, 20);
    expect(withDue.blocks.map((b) => b.kind)).toEqual(['reviews']);

    const weakest = buildSession(
      {
        ...base,
        topics: [
          { id: 'A', order: 0, mastery: 0.7, studied: true },
          { id: 'B', order: 1, mastery: 0.2, studied: true },
          { id: 'C', order: 2, mastery: null, studied: false },
        ],
      },
      20,
    );
    expect(weakest.blocks).toEqual([{ kind: 'quiz_weak', topicId: 'B', questionCount: 5, minutes: 10 }]);

    const empty = buildSession(base, 20);
    expect(empty.blocks).toEqual([{ kind: 'done' }]);
    expect(empty.fallback).toBe(true);
  });
});

describe('GOL-08 readiness (§13.1)', () => {
  it('sums ω · cov · m; unstudied topics add nothing', () => {
    const r = readiness([
      { id: 'A', weight: 0.5, studied: true, mastery: 0.8 },
      { id: 'B', weight: 0.5, studied: false, mastery: 0.9 },
    ]);
    expect(r.value).toBeCloseTo(0.4, 9);
    expect(r.coveredWeight).toBeCloseTo(0.5, 9);
    expect(r.perTopic).toEqual({ A: 0.8, B: 0 });
  });
});

describe('GOL-11 predicted grade (§13.2)', () => {
  const topics: PredictionTopic[] = [
    { id: 'A', weight: 0.5, studied: true, lambda: 1, retrievabilityAtExam: 0.9, accuracyAtExam: null, masteryNow: 0.9 },
    { id: 'B', weight: 0.5, studied: true, lambda: 1, retrievabilityAtExam: 0.9, accuracyAtExam: null, masteryNow: 0.9 },
  ];

  it('returns not_enough below the evidence gate (15 answered questions)', () => {
    expect(predictedGrade({ topics, scaleMax: 10, answeredQuestionsInScope: 14 })).toBe('not_enough');
  });

  it('point estimate and 80% interval match the hand computation (readiness 0.9, σ = √(1.5² + 2.12²) ≈ 2.60)', () => {
    const p = predictedGrade({ topics, scaleMax: 10, answeredQuestionsInScope: 20 });
    expect(p).not.toBe('not_enough');
    if (p === 'not_enough') return;
    expect(p.grade).toBeCloseTo(9, 1);
    expect(p.sigma).toBeCloseTo(2.598, 2);
    // ĝ ± 1.28σ, clipped to [0, 10], rounded outward to 0.5.
    expect(p.lo).toBe(5.5);
    expect(p.hi).toBe(10);
    expect(p.lo % 0.5).toBe(0);
  });

  it('the evidence gate also needs half the test covered', () => {
    const thin = [{ ...topics[0]!, weight: 0.4, studied: true }, { ...topics[1]!, weight: 0.6, studied: false }];
    expect(predictedGrade({ topics: thin, scaleMax: 10, answeredQuestionsInScope: 30 })).toBe('not_enough');
  });

  it('calibrated mapping shrinks toward the prior with k = 5', () => {
    // Perfect data y = 1·x would give (a, b) = (0, 1); with n = 3 and k = 5 the shrink gives 3/8 of the fit.
    const fit = fitGradeMapping(
      [
        { x: 2, y: 4 },
        { x: 4, y: 8 },
        { x: 6, y: 12 },
      ],
      { a: 0, b: 1 },
      5,
    );
    expect(fit.n).toBe(3);
    expect(fit.b).toBeCloseTo((3 * 2 + 5 * 1) / 8, 9);
    expect(fit.a).toBeCloseTo(0, 9);
  });
});

describe('GOL-07 Modo Véspera', () => {
  const exams = [
    { id: 'a', title: 'Prova A', localDate: '2026-11-03', startTime: '07:30', weight: 1, readiness: 0.2 },
    { id: 'b', title: 'Prova B', localDate: '2026-11-03', startTime: null, weight: 1, readiness: 0.8 },
  ];
  const scope = [
    { topicId: 'A1', examId: 'a', title: 'Átomos', weight: 0.6, studied: true, mastery: 0.3 },
    { topicId: 'A2', examId: 'a', title: 'Ligações', weight: 0.4, studied: false, mastery: null },
    { topicId: 'B1', examId: 'b', title: 'Funções', weight: 1, studied: true, mastery: 0.9 },
  ];

  it('is null when no test is tomorrow', () => {
    expect(buildVespera({ today: '2026-11-01', exams, scope, errorCardIds: {}, unresolvedMistakeIds: {} })).toBeNull();
  });

  it('two tests on one date: one session, 35 minutes split by weight × (1 − readiness)', () => {
    const v = buildVespera({ today: '2026-11-02', exams, scope, errorCardIds: { a: ['e1'] }, unresolvedMistakeIds: { b: ['m1'] } });
    expect(v).not.toBeNull();
    if (!v) return;
    expect(v.totalMinutes).toBe(35);
    expect(v.minutesByExam).toEqual({ a: 28, b: 7 });
    expect(v.parts.map((p) => p.kind)).toEqual(['cheatsheet', 'revisao_relampago', 'error_cards', 'mistakes', 'checklist', 'sleep']);
    const cheat = v.parts[0];
    if (cheat?.kind === 'cheatsheet') {
      // Unstudied topics are flagged, not introduced (GOL-07.3).
      expect(cheat.topics.find((t) => t.topicId === 'A2')?.notStudied).toBe(true);
    }
  });

  it('sleep stop is 8.5 h before the start, 22:00 when unknown, and notification moves out of quiet hours', () => {
    expect(sleepStopTime('07:30')).toBe('23:00');
    expect(sleepStopTime(null)).toBe('22:00');
    expect(notifyTime('19:00')).toBe('19:00');
    expect(notifyTime('23:00')).toBe('21:00');
  });
});

describe('calendar helpers', () => {
  it('01:30 in São Paulo belongs to the previous study day; 05:00 does not', () => {
    // 2026-11-02T04:30Z is 01:30 at UTC−3 (São Paulo, no DST since 2019).
    expect(planStudyDayOf(Date.parse('2026-11-02T04:30:00Z'), 'America/Sao_Paulo')).toBe('2026-11-01');
    expect(planStudyDayOf(Date.parse('2026-11-02T08:00:00Z'), 'America/Sao_Paulo')).toBe('2026-11-02');
  });

  it('days until the exam counts whole study days', () => {
    expect(planDaysUntil('2026-11-06', '2026-11-02')).toBe(4);
  });
});
