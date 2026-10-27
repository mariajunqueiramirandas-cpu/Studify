import { describe, expect, it } from 'vitest';
import {
  attackCoverage,
  buildPlan,
  desperateEligibility,
  diagnosticTopics,
  planAttack,
  type PlanExam,
  type PlanInput,
  type PlanTopic,
} from '../../src/planning/index.ts';
import { addDays } from '../../src/planning/util.ts';

describe('GOL-12.1 eligibility', () => {
  const base = { today: '2026-11-02', scheduled: true, coverage: 0.2, readiness: 0.1, sessions: 0 };

  it('offers the mode for a test 4 days away with little done', () => {
    const r = desperateEligibility({ ...base, examLocalDate: '2026-11-06' });
    expect(r.eligible).toBe(true);
    expect(r.daysLeft).toBe(4);
    expect(r.reasons).toEqual(['low_coverage', 'low_readiness', 'no_sessions']);
  });

  it('does not offer it 8 days away (acceptance criterion)', () => {
    expect(desperateEligibility({ ...base, examLocalDate: '2026-11-10' }).eligible).toBe(false);
  });

  it('does not offer it when preparation is already high', () => {
    const r = desperateEligibility({ ...base, examLocalDate: '2026-11-05', coverage: 0.8, readiness: 0.6, sessions: 3 });
    expect(r.eligible).toBe(false);
  });
});

describe('GOL-12.3 diagnostic composition', () => {
  it('orders by weight, caps at 12 and at 6 for a test today or tomorrow', () => {
    const scope = Array.from({ length: 15 }, (_, i) => ({ topicId: `t${i}`, order: i, weight: i % 2 === 0 ? 0.1 : 0.2 }));
    expect(diagnosticTopics(scope, 4)).toHaveLength(12);
    expect(diagnosticTopics(scope, 1)).toHaveLength(6);
    expect(diagnosticTopics(scope, 4)[0]).toBe('t1');
  });
});

describe('GOL-12.5 plano de ataque (§8.10.2)', () => {
  // Ten equal topics: learn 20 min (light 10), gain 0.1 each, so yield ties and map order decides.
  const topics = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, order: i, learnMin: 20, gain: 0.1 }));

  it('Foco total fills 70% of capacity by yield, Só o básico takes the light remainder, the rest is out', () => {
    // capacity 240 → focus budget 168 → eight topics at 20 each (160); the ninth would reach 180.
    const plan = planAttack(topics, 240);
    expect(Object.entries(plan.groups).filter(([, g]) => g === 'focus').map(([id]) => id)).toEqual(
      ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'],
    );
    expect(plan.groups.T9).toBe('basic');
    expect(plan.groups.T10).toBe('basic');
    expect(plan.focusMin).toBe(160);
    // Remaining capacity 80: basic light minutes 10 + 10.
    expect(plan.basicMin).toBe(20);
  });

  it('coverage is 100 · (Σ focus ω + ½ Σ basic ω), rounded to 5%', () => {
    const plan = planAttack(topics, 240);
    const omega = Object.fromEntries(topics.map((t) => [t.id, 0.1]));
    expect(attackCoverage(plan.groups, { bio: omega })).toEqual({ bio: 90 });
  });

  it('a topic moved by hand keeps its group on recompute and consumes budget first', () => {
    const plan = planAttack(topics, 240, { T9: 'focus' });
    expect(plan.groups.T9).toBe('focus');
    expect(Object.values(plan.groups).filter((g) => g === 'focus')).toHaveLength(8);
    expect(plan.groups.T8).toBe('basic');
  });

  it('moving a topic out removes it from every other group', () => {
    const plan = planAttack(topics, 240, { T1: 'out' });
    expect(plan.groups.T1).toBe('out');
    expect(plan.groups.T9).toBe('focus');
    expect(plan.groups.T10).toBe('basic');
  });
});

describe('GOL-12 integration through buildPlan (desperate mode)', () => {
  const today = '2026-11-02';
  const exam: PlanExam = {
    id: 'fis',
    subjectId: 'fis',
    title: 'Prova de Física',
    localDate: addDays(today, 4),
    status: 'scheduled',
    weight: 1,
    scopeTopicIds: Array.from({ length: 10 }, (_, i) => `F${i + 1}`),
    topicWeights: null,
    requiredRatio: null,
  };
  const topics: PlanTopic[] = Array.from({ length: 10 }, (_, i) => ({
    id: `F${i + 1}`,
    subjectId: 'fis',
    order: i,
    sources: [{ kind: 'textbook' as const, pages: 15 }],
    studied: false,
    mastery: null,
  }));
  const input: PlanInput = {
    today,
    timeZone: 'America/Sao_Paulo',
    exams: [exam],
    topics,
    availability: { minutesByWeekday: [60, 60, 60, 60, 60, 60, 60] },
    reviewForecast: {},
    mode: 'desperate',
    desperate: { minutesPerDay: 60, coveredExamIds: ['fis'] },
  };

  it('plans only Foco total and Só o básico topics, with the mini-simulado on D − 2', () => {
    // Capacity 60/60/40/35 = 195 after the mini-simulado (20) and véspera (25). Light = 30, cost = 40.
    // Focus budget 0.7 × 195 = 136.5 → 3 topics (120); basic light 30 each in the remaining 75 → 2 topics.
    const run = buildPlan(input, 'manual_edit');
    const groups = run.attack?.groups ?? {};
    const count = (g: string) => Object.values(groups).filter((x) => x === g).length;
    expect([count('focus'), count('basic'), count('out')]).toEqual([3, 2, 5]);
    const out = Object.keys(groups).filter((id) => groups[id] === 'out');
    for (const id of out) {
      expect(run.items.some((i) => i.topicId === id), id).toBe(false);
    }
    const mini = run.items.find((i) => i.unitKey === 'mock:fis');
    expect(mini?.day).toBe(addDays(exam.localDate, -2));
    expect(mini?.minutes).toBe(20);
  });

  it('never plans after 23:00 and never more than 240 minutes a day', () => {
    const run = buildPlan(input, 'manual_edit');
    for (const it of run.items) expect(it.endMin).toBeLessThanOrEqual(23 * 60);
    for (const load of run.days) expect(load.plannedMin).toBeLessThanOrEqual(240);
  });

  it('reports a coverage estimate for the covered test', () => {
    const run = buildPlan(input, 'manual_edit');
    // 3 focus topics × 0.1 + 2 basic × 0.1 × ½ = 0.4.
    expect(run.attack?.coverage.fis).toBe(40);
  });
});
