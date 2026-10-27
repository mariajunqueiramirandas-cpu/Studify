import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  composeSimulado,
  empiricalDifficultyBands,
  examUrgency,
  nextRecallKind,
  pickMeTestaNode,
  predictSuccess,
  refitPredictionModel,
  resolveParams,
  selectAdaptiveQuiz,
  selectDuelQuestions,
  simuladoGrade,
  type ExamScope,
  type QuizCandidate,
  type SimuladoCandidate,
} from '../../src/learning/index.ts';
import { seededRandom } from '../../src/learning/rng.ts';

const params = resolveParams();
const NOW = new Date('2026-10-27T12:00:00Z');

function quiz(over: Partial<QuizCandidate> & { questionId: string }): QuizCandidate {
  return {
    conceptId: 'k-' + over.questionId,
    questionType: 'mcq_single',
    pHat: 0.72,
    seenBefore: true,
    daysSinceCorrect: null,
    overconfident: false,
    examUrgency: 0,
    ...over,
  };
}

describe('predicted success p̂ (§6.1)', () => {
  it('at m = 0.5 and medium difficulty, p̂ = σ(1.1) ≈ 0.75', () => {
    expect(predictSuccess({ difficulty: 3, conceptMasteries: [0.5] })).toBeCloseTo(0.75, 2);
  });

  it('rises with mastery and falls with difficulty', () => {
    const easyLow = predictSuccess({ difficulty: 1, conceptMasteries: [0.2] });
    const hardLow = predictSuccess({ difficulty: 5, conceptMasteries: [0.2] });
    const hardHigh = predictSuccess({ difficulty: 5, conceptMasteries: [0.9] });
    expect(hardHigh).toBeGreaterThan(hardLow);
    expect(easyLow).toBeGreaterThan(hardLow);
  });

  it('averages multi-concept masteries and treats null as 0.5', () => {
    const avg = predictSuccess({ difficulty: 3, conceptMasteries: [0.2, 0.8] });
    expect(avg).toBeCloseTo(predictSuccess({ difficulty: 3, conceptMasteries: [0.5] }), 12);
    expect(predictSuccess({ difficulty: 3, conceptMasteries: [null] })).toBeCloseTo(predictSuccess({ difficulty: 3, conceptMasteries: [0.5] }), 12);
  });

  it('refit keeps the prior below 200 attempts and shrinks the fit toward it', () => {
    const few = Array.from({ length: 50 }, (_, i) => ({ difficulty: 3, mastery: 0.5, correct: i % 2 === 0 }));
    expect(refitPredictionModel(few)).toMatchObject({ refitted: false, model: { alpha: 1.5, beta0: 1.1 } });

    // Synthetic data from α = 2.0, β₀ = 0.5 with a seeded generator.
    const rng = seededRandom('refit-check');
    const data = Array.from({ length: 3000 }, () => {
      const difficulty = 1 + Math.floor(rng() * 5);
      const mastery = rng();
      const x = 2 * mastery - 1 - (difficulty - 3) / 2;
      const p = 1 / (1 + Math.exp(-(0.5 + 2.0 * x)));
      return { difficulty, mastery, correct: rng() < p };
    });
    const fit = refitPredictionModel(data);
    expect(fit.refitted).toBe(true);
    expect(fit.model.alpha).toBeGreaterThan(1.6);
    expect(fit.model.alpha).toBeLessThan(2.4);
    expect(fit.model.beta0).toBeGreaterThan(0.2);
    expect(fit.model.beta0).toBeLessThan(0.8);
  });
});

describe('examUrgency (§6.2)', () => {
  const exam = (over: Partial<ExamScope> & { examId: string; startsAt: Date }): ExamScope => ({
    status: 'scheduled',
    localDate: '2026-10-28',
    weight: 1,
    weightNorm: 1,
    nodeIds: ['c1'],
    ...over,
  });

  it('weight_norm × exp(−days/7) for the earliest exam containing the concept', () => {
    const tomorrow = exam({ examId: 'a', startsAt: new Date('2026-10-28T12:00:00Z'), weightNorm: 0.5 });
    expect(examUrgency('c1', [tomorrow], NOW, params)).toBeCloseTo(0.5 * Math.exp(-1 / 7), 10);
  });

  it('is zero without an exam in scope, for past exams, and for exams that are cancelled or done', () => {
    const inScopeLater = exam({ examId: 'b', startsAt: new Date('2026-11-10T12:00:00Z') });
    expect(examUrgency('other', [inScopeLater], NOW, params)).toBe(0);
    expect(examUrgency('c1', [exam({ examId: 'p', startsAt: new Date('2026-10-01T12:00:00Z') })], NOW, params)).toBe(0);
    expect(examUrgency('c1', [exam({ examId: 'x', startsAt: new Date('2026-10-28T12:00:00Z'), status: 'cancelled' })], NOW, params)).toBe(0);
  });
});

describe('adaptive quiz selection (§6.3)', () => {
  it('excludes questions answered correctly in the last 7 days', () => {
    const ids = selectAdaptiveQuiz(
      [quiz({ questionId: 'recent', daysSinceCorrect: 3 }), quiz({ questionId: 'old', daysSinceCorrect: 9 })],
      5,
    );
    expect(ids).toEqual(['old']);
  });

  it('prefers p̂ near 0.72 and rewards unseen questions', () => {
    const ids = selectAdaptiveQuiz(
      [
        quiz({ questionId: 'far', pHat: 0.2, seenBefore: true }),
        quiz({ questionId: 'near-unseen', pHat: 0.7, seenBefore: false }),
        quiz({ questionId: 'near-seen', pHat: 0.7, seenBefore: true }),
      ],
      1,
    );
    expect(ids).toEqual(['near-unseen']);
  });

  it('allows at most two questions per concept', () => {
    const cands = ['a', 'b', 'c', 'd'].map((id) => quiz({ questionId: id, conceptId: 'same', pHat: 0.72 }));
    expect(selectAdaptiveQuiz(cands, 4)).toHaveLength(2);
  });

  it('covers at least three question types when available', () => {
    const cands = [
      quiz({ questionId: 'm1', questionType: 'mcq_single', pHat: 0.72 }),
      quiz({ questionId: 'm2', questionType: 'mcq_single', pHat: 0.72 }),
      quiz({ questionId: 'm3', questionType: 'mcq_single', pHat: 0.72 }),
      quiz({ questionId: 't1', questionType: 'true_false', pHat: 0.4 }),
      quiz({ questionId: 'f1', questionType: 'fill_blank', pHat: 0.3 }),
    ];
    const ids = selectAdaptiveQuiz(cands, 3);
    const types = new Set(ids.map((id) => cands.find((c) => c.questionId === id)?.questionType));
    expect(types.size).toBe(3);
  });

  it('Caderno retries due go first', () => {
    const ids = selectAdaptiveQuiz(
      [quiz({ questionId: 'best', pHat: 0.72 }), quiz({ questionId: 'retry', pHat: 0.1, cadernoRetryDue: true })],
      1,
    );
    expect(ids).toEqual(['retry']);
  });
});

describe('simulado composition (§6.4)', () => {
  const topics = [
    { topicId: 't1', weight: 1 },
    { topicId: 't2', weight: 1 },
    { topicId: 't3', weight: 1 },
  ];
  const bank: SimuladoCandidate[] = [];
  for (const t of ['t1', 't2', 't3']) {
    for (let i = 0; i < 12; i++) {
      bank.push({ questionId: `${t}-${i}`, topicId: t, difficulty: 1 + (i % 5), daysSinceSeen: null });
    }
  }

  it('allocates by largest remainder, every topic gets at least one', () => {
    const r = composeSimulado({ count: 10, topics, candidates: bank, seed: 'u|q1' });
    expect(Object.values(r.perTopic).reduce((a, b) => a + b, 0)).toBe(10);
    expect(Object.values(r.perTopic).sort()).toEqual([3, 3, 4]);
    expect(new Set(r.questionIds).size).toBe(10);
    expect(r.shortfall).toBe(0);
  });

  it('is deterministic for the same seed', () => {
    const a = composeSimulado({ count: 10, topics, candidates: bank, seed: 'u|q1' });
    const b = composeSimulado({ count: 10, topics, candidates: bank, seed: 'u|q1' });
    expect(a).toEqual(b);
  });

  it('excludes questions seen in the last 7 days unless the bank is short, then reports shortfall', () => {
    const seen = bank.map((c) => ({ ...c, daysSinceSeen: 2 }));
    const onlySeen = composeSimulado({ count: 3, topics: [{ topicId: 't1', weight: 1 }], candidates: seen, seed: 's' });
    expect(onlySeen.questionIds).toHaveLength(3); // fallback reuses the oldest-seen questions
    const empty = composeSimulado({ count: 5, topics: [{ topicId: 't1', weight: 1 }], candidates: [], seed: 's' });
    expect(empty.shortfall).toBe(5);
  });

  it('interleaved order alternates topics', () => {
    const r = composeSimulado({ count: 6, topics, candidates: bank, seed: 'u|q2', order: 'interleaved' });
    const tops = r.questionIds.map((id) => id.split('-')[0]);
    expect(tops.slice(0, 3)).toEqual(['t1', 't2', 't3']);
  });

  it('simulado grade is round1(score_pct × scale_max)', () => {
    expect(simuladoGrade(7, 10, 10)).toBe(7);
    expect(simuladoGrade(2, 3, 10)).toBe(6.7);
    expect(simuladoGrade(0, 0, 10)).toBe(0);
  });
});

describe('empirical difficulty (§6.5)', () => {
  it('needs at least 20 first attempts and maps errors to quintiles per subject', () => {
    const stats = Array.from({ length: 10 }, (_, i) => ({
      questionId: `q${i}`,
      subjectId: 'bio',
      firstAttempts: 20,
      pCorrectFirst: 1 - i / 10, // higher index → more errors → harder
    }));
    stats.push({ questionId: 'few', subjectId: 'bio', firstAttempts: 5, pCorrectFirst: 0 });
    const bands = empiricalDifficultyBands(stats);
    expect(bands.has('few')).toBe(false);
    expect(bands.get('q0')).toBe(1);
    expect(bands.get('q1')).toBe(1);
    expect(bands.get('q9')).toBe(5);
    expect(bands.get('q4')).toBe(3);
  });
});

describe('Me testa node selection (§6.6)', () => {
  it('recall/understanding/application mix converges to 40/40/20', () => {
    const history: ReturnType<typeof nextRecallKind>[] = [];
    for (let i = 0; i < 10; i++) history.push(nextRecallKind(history));
    const count = (k: string): number => history.filter((h) => h === k).length;
    expect(count('recall')).toBe(4);
    expect(count('understanding')).toBe(4);
    expect(count('application')).toBe(2);
  });

  it('phase 1 avoids the nodes asked in the last two rounds', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ nodeId: id, mastery: 0.5, openCaderno: false, nearestExam: false }));
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), (seed) => {
        const picked = pickMeTestaNode({ phase: 1, nodes, recentNodeIds: ['a', 'b'], seed });
        expect(['c', 'd']).toContain(picked);
      }),
      { numRuns: 100 },
    );
  });

  it('phase 2 favours low mastery and open Caderno entries', () => {
    const nodes = [
      { nodeId: 'strong', mastery: 0.95, openCaderno: false, nearestExam: false },
      { nodeId: 'weak', mastery: 0.05, openCaderno: true, nearestExam: true },
    ];
    const weakFirst = Array.from({ length: 200 }, (_, i) => pickMeTestaNode({ phase: 2, nodes, recentNodeIds: [], seed: `t|${i}` }));
    const weakShare = weakFirst.filter((id) => id === 'weak').length / weakFirst.length;
    expect(weakShare).toBeGreaterThan(0.8);
  });
});

describe('duel selection (§6.7)', () => {
  it('draws the requested count, honours the per-topic cap, and avoids questions answered in the last week', () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      questionId: `q${i}`,
      topicId: `t${i % 4}`,
      difficulty: 1 + (i % 5),
      daysSinceAnswered: i < 10 ? 2 : null,
    }));
    const ids = selectDuelQuestions({ duelId: 'duel-1', candidates, targetMastery: 0.5, count: 10, topicCount: 4 });
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids.every((id) => Number(id.slice(1)) >= 10)).toBe(true);
    const perTopic = new Map<string, number>();
    for (const id of ids) {
      const topic = candidates.find((c) => c.questionId === id)!.topicId;
      perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
    }
    expect(Math.max(...perTopic.values())).toBeLessThanOrEqual(Math.ceil(10 / 4) + 1);
  });

  it('is deterministic for the same duel id', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ questionId: `q${i}`, topicId: `t${i % 3}`, difficulty: 1 + (i % 5), daysSinceAnswered: null }));
    const a = selectDuelQuestions({ duelId: 'd', candidates, targetMastery: 0.6, count: 8, topicCount: 3 });
    const b = selectDuelQuestions({ duelId: 'd', candidates, targetMastery: 0.6, count: 8, topicCount: 3 });
    expect(a).toEqual(b);
  });
});
