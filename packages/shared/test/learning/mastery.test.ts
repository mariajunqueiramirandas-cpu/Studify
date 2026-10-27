import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  accuracyAt,
  aggregateEvidence,
  decayFactor,
  detectMasteryShift,
  emptyLedger,
  evidenceWeight,
  foldEvidence,
  masteryAt,
  masteryOrDefault,
  newCardState,
  recordEvidence,
  resolveParams,
  retrievability,
  type CardState,
  type EvidenceEvent,
  type EvidenceQuestionType,
  type EvidenceSource,
} from '../../src/learning/index.ts';

const params = resolveParams();
const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 86_400_000;

function ev(over: Partial<EvidenceEvent> & { id: string; answeredAt: Date }): EvidenceEvent {
  return {
    conceptId: 'c1',
    questionType: 'mcq_single',
    source: 'quiz',
    score: 1,
    confidence: null,
    ...over,
  };
}

function weight(questionType: EvidenceQuestionType, source: EvidenceSource, extra: Partial<EvidenceEvent> = {}): number {
  return evidenceWeight(ev({ id: 'w', answeredAt: NOW, questionType, source, ...extra }));
}

describe('evidence weights (§5.2)', () => {
  it('type weights', () => {
    expect(weight('true_false', 'quiz')).toBe(0.5);
    expect(weight('mcq_single', 'quiz')).toBe(1);
    expect(weight('multi_select', 'quiz')).toBe(1.2);
    expect(weight('short_answer', 'quiz')).toBe(1.5);
    expect(weight('find_error', 'quiz')).toBe(1.5);
    expect(weight('essay_question', 'quiz')).toBe(2);
  });

  it('source multipliers', () => {
    expect(weight('mcq_single', 'tutor_quiz')).toBe(0.5);
    expect(weight('mcq_single', 'duel')).toBe(0.75);
    expect(weight('mcq_single', 'battle')).toBe(0.75);
    expect(weight('mcq_single', 'lucas')).toBe(0.75);
    expect(weight('mcq_single', 'self_override')).toBe(0.5);
    expect(weight('mcq_single', 'diagnostic')).toBe(1);
    expect(weight('mcq_single', 'caderno_retry')).toBe(1);
  });

  it('confidence multipliers apply only to correct answers', () => {
    expect(weight('mcq_single', 'quiz', { confidence: 4, score: 1 })).toBeCloseTo(1.2, 10);
    expect(weight('mcq_single', 'quiz', { confidence: 1, score: 1 })).toBeCloseTo(0.5, 10);
    expect(weight('mcq_single', 'quiz', { confidence: 4, score: 0 })).toBe(1);
    expect(weight('mcq_single', 'quiz', { confidence: 2, score: 1 })).toBe(1);
  });

  it('problem items: 2.0 × hint credit (1, 0.75, 0.5, 0.25), 0 once the solution is viewed', () => {
    expect(weight('problem', 'quiz', { hintsUsed: 0 })).toBeCloseTo(2, 10);
    expect(weight('problem', 'quiz', { hintsUsed: 1 })).toBeCloseTo(1.5, 10);
    expect(weight('problem', 'quiz', { hintsUsed: 2 })).toBeCloseTo(1, 10);
    expect(weight('problem', 'quiz', { hintsUsed: 3 })).toBeCloseTo(0.5, 10);
    expect(weight('problem', 'quiz', { solutionViewed: true })).toBe(0);
  });

  it('assisted camera solutions: no positive evidence; a wrong attempt is negative with weight 1.0', () => {
    expect(weight('mcq_single', 'camera', { score: 1, solutionViewed: true })).toBe(0);
    expect(weight('mcq_single', 'camera', { score: 0 })).toBe(1);
    expect(weight('mcq_single', 'camera', { score: 1, solutionViewed: false })).toBe(1);
  });
});

describe('decay (§5.1, 7-day half-life)', () => {
  it('halves every 7 days', () => {
    expect(decayFactor(0)).toBe(1);
    expect(decayFactor(7 * DAY)).toBeCloseTo(0.5, 12);
    expect(decayFactor(14 * DAY)).toBeCloseTo(0.25, 12);
  });

  it('accuracy decays toward the Beta(1,1) prior 0.5', () => {
    const agg = aggregateEvidence([0, 1, 2, 3].map((i) => ev({ id: `e${i}`, answeredAt: NOW })));
    expect(accuracyAt(agg, NOW)).toBeCloseTo(5 / 6, 10);
    expect(accuracyAt(agg, new Date(NOW.getTime() + 7 * DAY))).toBeCloseTo(0.75, 10);
  });
});

describe('incremental update equals the batch computation (§5.3)', () => {
  const events: EvidenceEvent[] = [
    ev({ id: 'a', answeredAt: new Date('2026-10-01T12:00:00Z'), score: 1 }),
    ev({ id: 'b', answeredAt: new Date('2026-10-04T12:00:00Z'), score: 0, questionType: 'short_answer' }),
    ev({ id: 'c', answeredAt: new Date('2026-10-20T12:00:00Z'), score: 0.5, questionType: 'essay_question', source: 'duel' }),
    ev({ id: 'd', answeredAt: new Date('2026-10-26T12:00:00Z'), score: 1, confidence: 4 }),
  ];

  it('folding in arrival order equals the closed-form sum Σ w·s·decay(t_ref − t_e)', () => {
    const t_ref = events[events.length - 1]!.answeredAt.getTime();
    const sumW = events.reduce((s, e) => s + evidenceWeight(e) * decayFactor(t_ref - e.answeredAt.getTime()), 0);
    const sumWS = events.reduce((s, e) => s + evidenceWeight(e) * e.score * decayFactor(t_ref - e.answeredAt.getTime()), 0);
    const agg = events.reduce(foldEvidence, aggregateEvidence([]));
    expect(agg.sumW).toBeCloseTo(sumW, 10);
    expect(agg.sumWS).toBeCloseTo(sumWS, 10);
    expect(agg.count).toBe(events.length);
  });

  it('is independent of arrival order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }), (shuffled) => {
        const batch = aggregateEvidence(events);
        const fromShuffled = aggregateEvidence(shuffled);
        expect(fromShuffled.count).toBe(batch.count);
        expect(fromShuffled.sumW).toBeCloseTo(batch.sumW, 10);
        expect(fromShuffled.sumWS).toBeCloseTo(batch.sumWS, 10);
        expect(fromShuffled.updatedAt?.getTime()).toBe(batch.updatedAt?.getTime());
      }),
      { numRuns: 50 },
    );
  });

  it('recording the same event id twice is a no-op (idempotent outbox replay)', () => {
    const e = ev({ id: 'dup', answeredAt: NOW });
    const once = recordEvidence(emptyLedger(), e, ['topic', 'unit']);
    const twice = recordEvidence(once, e, ['topic', 'unit']);
    expect(twice.byNode).toEqual(once.byNode);
    expect(Object.keys(once.byNode).sort()).toEqual(['c1', 'topic', 'unit']);
    expect(once.byNode['topic']?.count).toBe(1);
  });
});

describe('mastery (§5.1)', () => {
  const freshCard = (id: string, daysSinceReview: number, stability: number): CardState => ({
    ...newCardState(id, NOW),
    state: 'review',
    reps: 3,
    stability,
    difficulty: 5,
    lastReview: new Date(NOW.getTime() - daysSinceReview * DAY),
    due: new Date(NOW.getTime() + DAY),
  });

  it('is null with neither cards nor question evidence', () => {
    const m = masteryAt({ agg: null, cards: [] }, NOW, params);
    expect(m.mastery).toBeNull();
    expect(m.retrievability).toBeNull();
    expect(m.retrievabilitySource).toBeNull();
    expect(m.evidenceCount).toBe(0);
    expect(m.studied).toBe(false);
  });

  it('cards only: λ = 1, so mastery is the mean retrievability', () => {
    const cards = [freshCard('a', 2, 4), freshCard('b', 10, 4)];
    const rs = cards.map((c) => retrievability(c, NOW, params)!);
    const m = masteryAt({ agg: null, cards }, NOW, params);
    expect(m.mastery).toBeCloseTo((rs[0]! + rs[1]!) / 2, 10);
    expect(m.retrievabilitySource).toBe('cards');
    expect(m.retrievability).toBeCloseTo(m.mastery!, 10);
  });

  it('questions only: λ = 0, so mastery is the Beta accuracy; retrievability comes from questions once there are 3', () => {
    const agg = aggregateEvidence([0, 1, 2, 3].map((i) => ev({ id: `q${i}`, answeredAt: NOW })));
    const m = masteryAt({ agg, cards: [] }, NOW, params);
    expect(m.mastery).toBeCloseTo(5 / 6, 10);
    expect(m.retrievabilitySource).toBe('questions');
    expect(m.retrievability).toBeCloseTo(5 / 6, 10);
    expect(m.evidenceCount).toBe(4);
    expect(m.studied).toBe(true);
  });

  it('with two question events there is no question-based retrievability and the node is not studied', () => {
    const agg = aggregateEvidence([ev({ id: 'x1', answeredAt: NOW }), ev({ id: 'x2', answeredAt: NOW })]);
    const m = masteryAt({ agg, cards: [] }, NOW, params);
    expect(m.retrievability).toBeNull();
    expect(m.studied).toBe(false);
  });

  it('both cards and questions: λ = 0.5', () => {
    const cards = [freshCard('a', 3, 4)];
    const agg = aggregateEvidence([0, 1].map((i) => ev({ id: `m${i}`, answeredAt: NOW, score: 1 })));
    const m = masteryAt({ agg, cards }, NOW, params);
    const r = retrievability(cards[0]!, NOW, params)!;
    const acc = accuracyAt(agg, NOW);
    expect(m.mastery).toBeCloseTo(0.5 * r + 0.5 * acc, 10);
    expect(m.retrievabilitySource).toBe('cards');
  });

  it('studied: any of a learn unit, five card reviews, or three questions', () => {
    expect(masteryAt({ agg: null, cards: [], learnUnitDone: true }, NOW, params).studied).toBe(true);
    const fiveReviews = [{ ...freshCard('r', 1, 4), reps: 5 }];
    expect(masteryAt({ agg: null, cards: fiveReviews }, NOW, params).studied).toBe(true);
  });

  it('suspended cards do not contribute retrievability', () => {
    const cards = [{ ...freshCard('s', 1, 4), suspended: true }];
    expect(masteryAt({ agg: null, cards }, NOW, params).mastery).toBeNull();
  });
});

describe('null defaults and shift (§5.4, §5.5)', () => {
  it('each consumer keeps its documented default', () => {
    expect(masteryOrDefault(null, 'planner')).toBe(0);
    expect(masteryOrDefault(null, 'feed')).toBe(0.5);
    expect(masteryOrDefault(null, 'adaptive')).toBe(0.5);
    expect(masteryOrDefault(null, 'enemTopic')).toBe(0.3);
    expect(masteryOrDefault(0.8, 'feed')).toBe(0.8);
  });

  it('flags nodes whose mastery moved by at least 0.15 between plan runs', () => {
    const shifted = detectMasteryShift(
      { a: 0.5, b: 0.2, c: null },
      { a: 0.65, b: 0.3, c: 0.9 },
      ['a', 'b', 'c'],
    );
    expect(shifted).toEqual(['a']);
  });
});
