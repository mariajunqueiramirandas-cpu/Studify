import { describe, expect, it } from 'vitest';
import {
  buildReviewQueue,
  effectiveDue,
  examDue,
  forecastReviewLoad,
  medianReviewSeconds,
  newCardState,
  resolveParams,
  retrievability,
  siblingsToBury,
  type CardState,
  type ExamScope,
  type QueueCard,
} from '../../src/learning/index.ts';
import { addDays, startOfStudyDay } from '../../src/learning/time.ts';

const params = resolveParams();
// 09:00 local on 2026-10-27 (study day 27th).
const NOW = new Date('2026-10-27T12:00:00Z');

function review(over: Partial<CardState> & { cardId: string; due: Date }): CardState {
  return {
    state: 'review',
    stability: 5,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    scheduledDays: 5,
    learningSteps: 0,
    lastReview: new Date(over.due.getTime() - 5 * 86_400_000),
    suspended: false,
    ...over,
  } as CardState;
}

function card(cardId: string, state: CardState, extra: Partial<QueueCard> = {}): QueueCard {
  return { cardId, subjectId: 'bio', conceptId: 'c-' + cardId, mapOrder: 0, state, ...extra };
}

function exam(over: Partial<ExamScope> & { examId: string; startsAt: Date; localDate: string }): ExamScope {
  return { status: 'scheduled', weight: 1, weightNorm: 1, nodeIds: [], ...over };
}

describe('exam overlay (MEM-02.5, §3.2)', () => {
  const T = new Date('2026-11-05T12:00:00Z'); // 09:00 local on the exam day
  const examScope = exam({ examId: 'e1', startsAt: T, localDate: '2026-11-05', nodeIds: ['c1'] });

  it('boosts a card whose retrievability on exam day is below target', () => {
    const s = review({ cardId: 'x', due: new Date('2026-11-08T12:00:00Z'), stability: 3, lastReview: new Date('2026-10-20T12:00:00Z') });
    const rT = retrievability(s, T, params);
    expect(rT).not.toBeNull();
    expect(rT!).toBeLessThan(params.rExam);
    const d = rT! >= 0.75 ? 1 : 3;
    const expected = startOfStudyDay(addDays('2026-11-05', -d));
    expect(examDue(s, examScope, NOW, params)?.getTime()).toBe(expected.getTime());
  });

  it('does not boost when retrievability on exam day already meets the target', () => {
    const s = review({ cardId: 'x', due: new Date('2026-11-08T12:00:00Z'), stability: 500, lastReview: new Date('2026-10-20T12:00:00Z') });
    expect(retrievability(s, T, params)!).toBeGreaterThanOrEqual(params.rExam);
    expect(examDue(s, examScope, NOW, params)).toBeNull();
  });

  it('leaves FSRS to handle cards due well before the day before the exam', () => {
    const s = review({ cardId: 'x', due: new Date('2026-10-30T12:00:00Z'), stability: 1 });
    expect(examDue(s, examScope, NOW, params)).toBeNull();
  });

  it('ignores exams in the past, beyond 14 days, cancelled, and unintroduced or suspended cards', () => {
    const s = review({ cardId: 'x', due: new Date('2026-11-08T12:00:00Z'), stability: 3, lastReview: new Date('2026-10-20T12:00:00Z') });
    expect(examDue(s, examScope, T, params)).toBeNull(); // exam already started
    const far = exam({ examId: 'f', startsAt: new Date('2026-11-20T12:00:00Z'), localDate: '2026-11-20' });
    expect(examDue(s, far, NOW, params)).toBeNull();
    expect(examDue(s, { ...examScope, status: 'cancelled' }, NOW, params)).toBeNull();
    expect(examDue({ ...s, suspended: true }, examScope, NOW, params)).toBeNull();
    expect(examDue(newCardState('n', NOW), examScope, NOW, params)).toBeNull();
  });

  it('effectiveDue is the minimum of the FSRS due and the overlay, and never changes FSRS state', () => {
    const s = review({ cardId: 'x', due: new Date('2026-11-08T12:00:00Z'), stability: 3, lastReview: new Date('2026-10-20T12:00:00Z') });
    const before = JSON.stringify(s);
    const eff = effectiveDue(s, [examScope], NOW, params);
    expect(eff.examId).toBe('e1');
    expect(eff.at.getTime()).toBeLessThan(s.due.getTime());
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('review queue order (§3.1)', () => {
  it('orders learning steps, then due reviews, then new cards interleaved 1 per 4 reviews', () => {
    const overdue = (i: number): QueueCard =>
      card(`r${i}`, review({ cardId: `r${i}`, due: new Date(NOW.getTime() - (i + 1) * 3_600_000), stability: 5 }));
    const cards: QueueCard[] = [
      card('l1', { ...review({ cardId: 'l1', due: new Date(NOW.getTime() - 60_000) }), state: 'learning', stability: 1 }),
      ...Array.from({ length: 8 }, (_, i) => overdue(i)),
      ...Array.from({ length: 6 }, (_, i) => card(`n${i}`, newCardState(`n${i}`, NOW), { mapOrder: i })),
    ];
    const queue = buildReviewQueue({ cards, exams: [], params, newQuota: 4 }, NOW);
    expect(queue[0]?.kind).toBe('learning');
    const kinds = queue.slice(1).map((e) => e.kind);
    expect(kinds).toEqual(['review', 'review', 'review', 'review', 'new', 'review', 'review', 'review', 'review', 'new', 'new', 'new']);
    expect(queue.filter((e) => e.kind === 'new').map((e) => e.cardId)).toEqual(['n0', 'n1', 'n2', 'n3']);
  });

  it('skips future reviews, buried, excluded and suspended cards', () => {
    const cards: QueueCard[] = [
      card('today', review({ cardId: 'today', due: new Date('2026-10-27T10:00:00Z') })),
      card('tomorrow', review({ cardId: 'tomorrow', due: new Date('2026-10-28T12:00:00Z') })),
      card('buried', review({ cardId: 'buried', due: new Date('2026-10-27T10:00:00Z') }), { buried: true }),
      card('excluded', review({ cardId: 'excluded', due: new Date('2026-10-27T10:00:00Z') }), { excluded: true }),
      card('suspended', { ...review({ cardId: 'suspended', due: new Date('2026-10-27T10:00:00Z') }), suspended: true }),
    ];
    const queue = buildReviewQueue({ cards, exams: [], params, newQuota: 0 }, NOW);
    expect(queue.map((e) => e.cardId)).toEqual(['today']);
  });

  it('caps due reviews by priority (1 − R)·(1 + exam factor), then keeps queue order', () => {
    // Higher stability means higher retrievability, so c0 (lowest stability) has the highest 1 − R.
    const cards: QueueCard[] = [0, 1, 2, 3, 4].map((i) =>
      card(`c${i}`, review({ cardId: `c${i}`, due: new Date(NOW.getTime() - (i + 1) * 60_000), stability: 1 + 2 * i })),
    );
    const rOf = (c: QueueCard): number => retrievability(c.state, NOW, params) ?? 0;
    const keep = [...cards].sort((a, b) => rOf(a) - rOf(b)).slice(0, 2).map((c) => c.cardId).sort();
    expect(keep).toEqual(['c0', 'c1']);
    const queue = buildReviewQueue({ cards, exams: [], params, newQuota: 0, dailyCap: 2 }, NOW);
    expect(queue.map((e) => e.cardId).sort()).toEqual(keep);
  });

  it('exam factor tips the cap toward cards in scope of an exam within 7 days', () => {
    const near = exam({
      examId: 'e-near',
      startsAt: new Date('2026-11-01T12:00:00Z'),
      localDate: '2026-11-01',
      nodeIds: ['c-in'],
      weightNorm: 1,
    });
    // R(in) ≈ 0.91 and R(out) ≈ 0.85 five days after the last review: without the exam 1 − R favours
    // 'out'; with the exam factor (×2 for an exam within 7 days) 'in' wins.
    const inScope = card('in', review({ cardId: 'in', due: new Date(NOW.getTime() - 60_000), stability: 6 }), { conceptId: 'c-in' });
    const outScope = card('out', review({ cardId: 'out', due: new Date(NOW.getTime() - 60_000), stability: 2.7 }), { conceptId: 'c-out' });
    const cards = [outScope, inScope];
    const withoutExam = buildReviewQueue({ cards, exams: [], params, newQuota: 0, dailyCap: 1 }, NOW);
    const withExam = buildReviewQueue({ cards, exams: [near], params, newQuota: 0, dailyCap: 1 }, NOW);
    expect(withoutExam.map((e) => e.cardId)).toEqual(['out']);
    expect(withExam.map((e) => e.cardId)).toEqual(['in']);
  });
});

describe('forecastReviewLoad (§3.4)', () => {
  it('counts a card on its due study day and adds planned new-card reviews on +1, +3 and +7', () => {
    const due = new Date('2026-10-28T12:00:00Z');
    const cards: QueueCard[] = [card('f1', review({ cardId: 'f1', due, stability: 5 }))];
    const forecast = forecastReviewLoad(cards, [], '2026-10-27', '2026-11-03', NOW, params, {
      newCardsPlanned: { '2026-10-27': 2 },
    });
    const byDate = Object.fromEntries(forecast.map((d) => [d.date, d.dueCount]));
    expect(forecast).toHaveLength(8);
    expect(byDate['2026-10-28']).toBe(1 + 2); // the card plus new cards from the 27th (+1)
    expect(byDate['2026-10-30']).toBe(2); // +3
    expect(byDate['2026-11-03']).toBe(2); // +7
  });

  it('estimates minutes from reviewSeconds (default 10 s)', () => {
    const cards: QueueCard[] = [card('f2', review({ cardId: 'f2', due: new Date('2026-10-27T10:00:00Z'), stability: 5 }))];
    const forecast = forecastReviewLoad(cards, [], '2026-10-27', '2026-10-27', NOW, params);
    expect(forecast[0]?.dueCount).toBe(1);
    expect(forecast[0]?.estMinutes).toBeCloseTo(10 / 60, 10);
  });

  it('median review seconds: capped at 60 s per log, with a fallback', () => {
    expect(medianReviewSeconds([10_000, 20_000, 30_000])).toBe(20);
    expect(medianReviewSeconds([120_000])).toBe(60);
    expect(medianReviewSeconds([])).toBe(10);
  });
});

describe('sibling burying (MEM-02.7)', () => {
  it('buries the other cards of the same sibling group, never the card itself or other groups', () => {
    const cards = [
      { cardId: 'a', siblingGroupId: 'note-1' },
      { cardId: 'b', siblingGroupId: 'note-1' },
      { cardId: 'c', siblingGroupId: 'note-2' },
      { cardId: 'd', siblingGroupId: null },
    ];
    expect(siblingsToBury('a', cards)).toEqual(['b']);
    expect(siblingsToBury('d', cards)).toEqual([]);
    expect(siblingsToBury('missing', cards)).toEqual([]);
  });
});
