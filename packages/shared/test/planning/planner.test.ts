import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { buildPlan, type PlanExam, type PlanInput, type PlanRun, type PlanTopic } from '../../src/planning/index.ts';
import { addDays } from '../../src/planning/util.ts';
import { planInputHash } from '../../src/planning/index.ts';

// learning-engine §11.11 worked example. 2026-10-26 is a Monday.
const TODAY = '2026-10-26';

const bio: PlanExam = {
  id: 'bio',
  subjectId: 'bio',
  title: 'Prova de Biologia',
  localDate: '2026-10-29',
  status: 'scheduled',
  weight: 1,
  scopeTopicIds: ['B1', 'B2'],
  topicWeights: null,
  requiredRatio: null,
};
const hist: PlanExam = {
  id: 'hist',
  subjectId: 'hist',
  title: 'Prova de História',
  localDate: '2026-10-30',
  status: 'scheduled',
  weight: 1,
  scopeTopicIds: ['H1'],
  topicWeights: null,
  requiredRatio: null,
};
const topics: PlanTopic[] = [
  { id: 'B1', subjectId: 'bio', order: 1, sources: [{ kind: 'textbook', pages: 5 }], studied: false, mastery: null },
  { id: 'B2', subjectId: 'bio', order: 2, sources: [{ kind: 'textbook', pages: 5 }], studied: false, mastery: null },
  { id: 'H1', subjectId: 'hist', order: 3, sources: [{ kind: 'textbook', pages: 5 }], studied: false, mastery: null },
];
const forecast = (minutes: number, from: string, to: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d = addDays(d, 1)) out[d] = minutes;
  return out;
};
const worked = (availabilityMin: number): PlanInput => ({
  today: TODAY,
  timeZone: 'America/Sao_Paulo',
  exams: [bio, hist],
  topics,
  availability: { minutesByWeekday: [availabilityMin, availabilityMin, availabilityMin, availabilityMin, availabilityMin, availabilityMin, availabilityMin] },
  reviewForecast: forecast(10, TODAY, '2026-10-30'),
});

/** `day unitKey minutes` lines, sorted: the form the worked-example table uses. */
function lines(run: PlanRun): string[] {
  return run.items
    .map((it) => `${it.day} ${it.unitKey} ${it.minutes}`)
    .sort();
}

describe('GOL-04 worked example (§11.11)', () => {
  it('reproduces the capacity after vésperas and the placement table', () => {
    const run = buildPlan(worked(70), 'scope_changed');
    const capacity = run.days.map((d) => [d.day, d.capacityMin]);
    expect(capacity).toEqual([
      ['2026-10-26', 60],
      ['2026-10-27', 60],
      ['2026-10-28', 35],
      ['2026-10-29', 5],
      ['2026-10-30', 30],
    ]);
    expect(lines(run)).toEqual(
      [
        '2026-10-26 learn:B1 20',
        '2026-10-26 learn:B2 20',
        '2026-10-26 learn:H1 20',
        '2026-10-27 practice:bio:B1 10',
        '2026-10-27 practice:hist:H1 10',
        '2026-10-27 mock:bio 21',
        '2026-10-27 mock:hist 18',
        '2026-10-28 practice:bio:B2 10',
        '2026-10-28 vespera:2026-10-29 25',
        '2026-10-29 vespera:2026-10-30 25',
      ].sort(),
    );
    expect(run.feasible).toBe(true);
    expect(run.triage).toEqual([]);
    expect(run.outOfPlan).toEqual([]);
    expect(run.tight).toEqual([]);
  });

  it('mock Bio lands on D − 2 and every deadline is met', () => {
    const run = buildPlan(worked(70), 'scope_changed');
    const mock = run.items.find((i) => i.unitKey === 'mock:bio');
    expect(mock?.day).toBe('2026-10-27');
    for (const it of run.items) {
      for (const e of it.examIds) {
        const exam = e === 'bio' ? bio : hist;
        expect(it.day < exam.localDate).toBe(true);
      }
    }
  });

  it('priorities follow π = W′ · ω · (1 − m) · (1 + ρ)', () => {
    const run = buildPlan(worked(70), 'scope_changed');
    const pri = (key: string) => run.items.find((i) => i.unitKey === key)?.priority;
    expect(pri('learn:B1')).toBeCloseTo(0.75, 9);
    expect(pri('learn:H1')).toBeCloseTo(1.5, 9);
    expect(pri('mock:bio')).toBeCloseTo(1.5, 9);
  });

  it('triage variant (A = 60): downgrades learn B2 to learn_light, then places everything', () => {
    const run = buildPlan(worked(60), 'scope_changed');
    expect(run.days.map((d) => d.capacityMin)).toEqual([50, 50, 25, 0, 25]);
    expect(run.triage).toEqual([{ step: 'downgrade_learn', unitKey: 'learn:B2', topicId: 'B2' }]);
    expect(run.feasible).toBe(false);
    expect(run.outOfPlan).toEqual([]);
    const b2 = run.items.find((i) => i.unitKey === 'learn:B2');
    expect(b2?.unitType).toBe('learn_light');
    expect(b2?.minutes).toBe(10);
    // Every planned unit is placed by its deadline.
    const keys = new Set(run.items.map((i) => i.unitKey));
    for (const k of ['learn:B1', 'learn:B2', 'learn:H1', 'practice:bio:B1', 'practice:bio:B2', 'practice:hist:H1', 'mock:bio', 'mock:hist']) {
      expect(keys.has(k), k).toBe(true);
    }
  });
});

describe('GOL-04 invariants', () => {
  const dayFromOffset = (n: number): string => addDays('2026-03-02', n);

  const scenarioArb = fc
    .record({
      start: fc.integer({ min: 0, max: 200 }),
      examCount: fc.integer({ min: 1, max: 4 }),
      examGaps: fc.array(fc.integer({ min: 2, max: 9 }), { minLength: 4, maxLength: 4 }),
      weights: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 4, maxLength: 4 }),
      topicCount: fc.integer({ min: 3, max: 8 }),
      pages: fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 8, maxLength: 8 }),
      mastery: fc.array(fc.option(fc.integer({ min: 0, max: 10 }).map((x) => x / 10), { nil: null }), { minLength: 8, maxLength: 8 }),
      studied: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
      availability: fc.array(fc.constantFrom(0, 30, 45, 60, 90, 120), { minLength: 7, maxLength: 7 }),
      reviews: fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 40, maxLength: 40 }),
    })
    .map((s) => {
      const today = dayFromOffset(s.start);
      let cumulative = 0;
      const exams: PlanExam[] = [];
      for (let i = 0; i < s.examCount; i++) {
        cumulative += s.examGaps[i] ?? 3;
        exams.push({
          id: `e${i}`,
          subjectId: `s${i % 3}`,
          title: `Prova ${i}`,
          localDate: addDays(today, cumulative),
          status: 'scheduled',
          weight: s.weights[i] ?? 1,
          // Scope: topics i, i+1 (mod count), every exam shares at least one topic.
          scopeTopicIds: [`t${i % s.topicCount}`, `t${(i + 1) % s.topicCount}`, `t${(i + 3) % s.topicCount}`].filter((v, idx, arr) => arr.indexOf(v) === idx),
          topicWeights: null,
          requiredRatio: null,
        });
      }
      const tps: PlanTopic[] = Array.from({ length: s.topicCount }, (_, i) => ({
        id: `t${i}`,
        subjectId: `s${i % 3}`,
        order: i,
        sources: [{ kind: 'notes', pages: s.pages[i] ?? 3 }],
        studied: s.studied[i] ?? false,
        mastery: s.mastery[i] ?? null,
      }));
      const forecastMap: Record<string, number> = {};
      for (let d = 0; d < 50; d++) forecastMap[addDays(today, d)] = s.reviews[d % s.reviews.length] ?? 0;
      return {
        today,
        timeZone: 'America/Sao_Paulo',
        exams,
        topics: tps,
        availability: { minutesByWeekday: s.availability },
        reviewForecast: forecastMap,
      } satisfies PlanInput;
    });

  it('no item sits on or after its exam day', () => {
    fc.assert(
      fc.property(scenarioArb, (input) => {
        const run = buildPlan(input, 'scope_changed');
        const examById = new Map(input.exams.map((e) => [e.id, e]));
        for (const it of run.items) {
          if (it.unitType === 'vespera') continue;
          for (const id of it.examIds) {
            const exam = examById.get(id);
            if (exam) expect(it.day < exam.localDate, `${it.unitKey} on ${it.day}`).toBe(true);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('daily minutes never exceed the day limit (plus ≤ 15 min per tight block)', () => {
    fc.assert(
      fc.property(scenarioArb, (input) => {
        const run = buildPlan(input, 'scope_changed');
        for (const load of run.days) {
          const nonVespera = run.items
            .filter((it) => it.day === load.day && it.unitType !== 'vespera')
            .reduce((a, it) => a + it.minutes, 0);
          const tightHere = run.items.filter((it) => it.day === load.day && run.tight.includes(it.id)).length;
          expect(load.reviewMin + nonVespera, `day ${load.day}`).toBeLessThanOrEqual(load.availableMin + 15 * tightHere + 1e-9);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('every in-scope topic with mastery < 0.8 gets a practice before its exam, or the plan reports it', () => {
    fc.assert(
      fc.property(scenarioArb, (input) => {
        const run = buildPlan(input, 'scope_changed');
        const present = new Set(run.items.map((it) => it.unitKey));
        for (const exam of input.exams) {
          for (const topicId of exam.scopeTopicIds) {
            const t = input.topics.find((x) => x.id === topicId);
            if (!t || t.isPlaceholder) continue;
            if ((t.mastery ?? 0) >= 0.8) continue;
            const key = `practice:${exam.id}:${topicId}`;
            const ok = present.has(key) || run.outOfPlan.includes(key);
            expect(ok, key).toBe(true);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('is deterministic and independent of input order', () => {
    fc.assert(
      fc.property(scenarioArb, (input) => {
        const a = buildPlan(input, 'scope_changed');
        const b = buildPlan(input, 'scope_changed');
        expect(b).toEqual(a);
        const shuffled: PlanInput = {
          ...input,
          exams: input.exams.slice().reverse(),
          topics: input.topics.slice().reverse(),
        };
        expect(buildPlan(shuffled, 'scope_changed').items).toEqual(a.items);
        expect(a.inputHash).toBe(planInputHash(input, 'scope_changed'));
      }),
      { numRuns: 80 },
    );
  });
});

describe('GOL-04 replanning', () => {
  const scenario: PlanInput = {
    today: '2026-03-02',
    timeZone: 'America/Sao_Paulo',
    exams: [
      { ...bio, localDate: '2026-03-09', scopeTopicIds: ['B1', 'B2'] },
      { ...hist, localDate: '2026-03-10', scopeTopicIds: ['H1'] },
    ],
    topics: topics.map((t) => ({ ...t, sources: [{ kind: 'notes' as const, pages: 6 }] })),
    availability: { minutesByWeekday: [60, 60, 60, 60, 60, 90, 90] },
    reviewForecast: forecast(5, '2026-03-02', '2026-03-10'),
  };

  it('a replan with no changes is a no-op (stability)', () => {
    const first = buildPlan(scenario, 'scope_changed');
    const again = buildPlan({ ...scenario, previous: first.items.map((i) => ({ ...i, status: i.status })) }, 'scope_changed');
    expect(again.items.map((i) => [i.id, i.day, i.minutes])).toEqual(first.items.map((i) => [i.id, i.day, i.minutes]));
    expect(again.movedMinutes).toBe(0);
    expect(again.reorganized).toBe(false);
  });

  it('never moves a done item, even when the test moves', () => {
    const first = buildPlan(scenario, 'scope_changed');
    const doneItem = first.items.find((i) => i.unitKey.startsWith('practice:'));
    expect(doneItem).toBeDefined();
    const previous = first.items.map((i) => ({
      id: i.id,
      unitKey: i.unitKey,
      unitType: i.unitType,
      examIds: i.examIds,
      topicId: i.topicId,
      day: i.day,
      minutes: i.minutes,
      pinned: i.pinned,
      status: i.id === doneItem?.id ? ('done' as const) : ('planned' as const),
      priority: i.priority,
      deadline: i.deadline,
    }));
    // Move the history test two days earlier (exam_changed replans from today, including today).
    const moved: PlanInput = {
      ...scenario,
      exams: [scenario.exams[0]!, { ...scenario.exams[1]!, localDate: '2026-03-08' }],
      previous,
    };
    const run = buildPlan(moved, 'exam_changed');
    const kept = run.items.find((i) => i.id === doneItem?.id);
    expect(kept?.day).toBe(doneItem?.day);
    expect(kept?.status).toBe('done');
    expect(run.items.filter((i) => i.id === doneItem?.id)).toHaveLength(1);
  });

  it('a nightly run returns unstarted past items to the pool and redistributes them', () => {
    const first = buildPlan(scenario, 'scope_changed');
    const tomorrow = addDays(scenario.today, 1);
    const previous = first.items.map((i) => ({
      id: i.id,
      unitKey: i.unitKey,
      unitType: i.unitType,
      examIds: i.examIds,
      topicId: i.topicId,
      day: i.day,
      minutes: i.minutes,
      pinned: false,
      status: 'planned' as const,
    }));
    const run = buildPlan({ ...scenario, today: tomorrow, previous }, 'nightly');
    // Today's items were not done: they come back to the pool and are placed again from tomorrow.
    const todaysKeys = first.items.filter((i) => i.day === scenario.today).map((i) => i.unitKey);
    for (const k of todaysKeys) expect(run.skipped).toContain(k);
    expect(run.items.every((i) => i.day >= tomorrow)).toBe(true);
    const placedKeys = new Set(run.items.map((i) => i.unitKey));
    for (const k of todaysKeys.filter((k) => k.startsWith('learn:'))) {
      expect(placedKeys.has(k), k).toBe(true);
    }
  });

  it('reorganized is true only when at least 15 minutes changed day', () => {
    const first = buildPlan(scenario, 'scope_changed');
    const pinnedFirst = first.items.map((i) => ({
      id: i.id,
      unitKey: i.unitKey,
      unitType: i.unitType,
      examIds: i.examIds,
      topicId: i.topicId,
      day: i.day,
      minutes: i.minutes,
      pinned: i.id.startsWith('mock:'),
      status: 'planned' as const,
    }));
    const availabilityDrop: PlanInput = {
      ...scenario,
      availability: { minutesByWeekday: [0, 0, 0, 0, 0, 0, 0] },
      previous: pinnedFirst,
    };
    const run = buildPlan(availabilityDrop, 'availability_changed');
    expect(run.feasible).toBe(false);
    expect(run.reorganized).toBe(run.movedMinutes >= 15);
  });
});

describe('GOL-04 snapshots per scenario', () => {
  it('worked example (§11.11)', () => {
    expect(lines(buildPlan(worked(70), 'scope_changed'))).toMatchSnapshot();
  });

  it('triage variant (A = 60)', () => {
    const run = buildPlan(worked(60), 'scope_changed');
    expect({ triage: run.triage, feasible: run.feasible, outOfPlan: run.outOfPlan, items: lines(run) }).toMatchSnapshot();
  });

  it('five subjects on consecutive days, a missed day and a test added mid-week', () => {
    const subjects = ['bio', 'hist', 'mat', 'geo', 'fis'];
    const exams: PlanExam[] = subjects.map((s, i) => ({
      id: `ex-${s}`,
      subjectId: s,
      title: `Prova de ${s}`,
      localDate: addDays('2026-05-04', i + 2),
      status: 'scheduled',
      weight: 1,
      scopeTopicIds: [`${s}-1`, `${s}-2`],
      topicWeights: null,
      requiredRatio: null,
    }));
    const tps: PlanTopic[] = subjects.flatMap((s) => [
      { id: `${s}-1`, subjectId: s, order: subjects.indexOf(s) * 2, sources: [{ kind: 'slides' as const, pages: 12 }], studied: false, mastery: null },
      { id: `${s}-2`, subjectId: s, order: subjects.indexOf(s) * 2 + 1, sources: [{ kind: 'notes' as const, pages: 8 }], studied: false, mastery: null },
    ]);
    const base: PlanInput = {
      today: '2026-05-04',
      timeZone: 'America/Sao_Paulo',
      exams,
      topics: tps,
      availability: { minutesByWeekday: [150, 150, 150, 150, 150, 180, 180] },
      reviewForecast: forecast(8, '2026-05-04', '2026-05-12'),
    };
    const first = buildPlan(base, 'scope_changed');
    // Added mid-week: a history test on May 8 joins; the same scope topic keeps a single learn unit.
    const withExtra: PlanInput = {
      ...base,
      exams: [...exams, { ...exams[0]!, id: 'ex-extra', title: 'Prova extra', localDate: '2026-05-08', scopeTopicIds: ['bio-1'] }],
      previous: first.items.map((i) => ({ id: i.id, unitKey: i.unitKey, unitType: i.unitType, examIds: i.examIds, topicId: i.topicId, day: i.day, minutes: i.minutes, pinned: false, status: 'planned' as const })),
    };
    const replanned = buildPlan(withExtra, 'exam_changed');
    expect({
      first: { items: lines(first), triage: first.triage, outOfPlan: first.outOfPlan, feasible: first.feasible },
      replanned: { items: lines(replanned), triage: replanned.triage, outOfPlan: replanned.outOfPlan, feasible: replanned.feasible },
      moved: replanned.movedMinutes,
    }).toMatchSnapshot();
  });

  it('a subject already mastered gets no learn unit', () => {
    const mastered: PlanInput = {
      ...worked(70),
      topics: topics.map((t) => (t.id === 'H1' ? { ...t, studied: true, mastery: 0.9 } : t)),
    };
    const run = buildPlan(mastered, 'scope_changed');
    expect(run.items.some((i) => i.unitKey === 'learn:H1')).toBe(false);
    expect(run.items.some((i) => i.unitKey === 'practice:hist:H1')).toBe(false);
    expect(lines(run)).toMatchSnapshot();
  });
});

describe('Mastery track (topics no test covers)', () => {
  const free: PlanTopic[] = [
    { id: 'M1', subjectId: 'mat', order: 1, sources: [{ kind: 'notes', pages: 5 }], studied: true, mastery: 0.3 },
    { id: 'M2', subjectId: 'mat', order: 2, sources: [{ kind: 'notes', pages: 5 }], studied: true, mastery: 0.9 },
    { id: 'M3', subjectId: 'mat', order: 3, sources: [{ kind: 'notes', pages: 5 }], studied: false, mastery: null },
  ];
  const noExams = (goal: number | null, reviews = 5): PlanInput => ({
    today: TODAY,
    timeZone: 'America/Sao_Paulo',
    exams: [],
    topics: free,
    availability: { minutesByWeekday: [60, 60, 60, 60, 60, 90, 90] },
    reviewForecast: forecast(reviews, TODAY, addDays(TODAY, 6)),
    masteryMinutesPerDay: goal,
  });
  const minutesOn = (run: PlanRun, day: string): number => run.items.filter((i) => i.day === day).reduce((a, i) => a + i.minutes, 0);

  it('without a daily goal, no exams means no plan', () => {
    expect(buildPlan(noExams(null), 'nightly').items).toEqual([]);
  });

  it('with no exams, plans a week of mastery work within the daily goal', () => {
    const run = buildPlan(noExams(20), 'nightly');
    expect(run.items.length).toBeGreaterThan(0);
    const days = new Set(run.items.map((i) => i.day));
    for (const d of days) {
      expect(d >= TODAY && d <= addDays(TODAY, 6)).toBe(true);
      // Goal 20 − 5 min of reviews = 15 left: one block always fits, more only within 5 min over.
      const day = run.items.filter((i) => i.day === d);
      expect(day.length === 1 || minutesOn(run, d) <= 15 + 5).toBe(true);
    }
    expect(run.items.every((i) => i.examIds.length === 0 && i.reason.key === 'plan.reason.mastery')).toBe(true);
    expect(run.feasible).toBe(true);
  });

  it('practices the weak studied topic first, skips the mastered one, and learns the new one before practicing it', () => {
    const run = buildPlan(noExams(20), 'nightly');
    const first = run.items.filter((i) => i.day === TODAY)[0];
    expect(first?.unitKey).toBe('practice:mastery:M1:0');
    expect(run.items.some((i) => i.topicId === 'M2')).toBe(false);
    const learnDays = run.items.filter((i) => i.unitKey === 'learn:M3').map((i) => i.day);
    const practice = run.items.find((i) => i.unitKey === 'practice:mastery:M3:0');
    expect(learnDays.length).toBeGreaterThan(0);
    if (practice) expect(practice.day > learnDays.sort().at(-1)!).toBe(true);
  });

  it('after a practice is done, schedules the next one from the following day', () => {
    const run = buildPlan(
      {
        ...noExams(20),
        previous: [{ id: 'practice:mastery:M1:0', unitKey: 'practice:mastery:M1:0', unitType: 'practice', examIds: [], topicId: 'M1', day: TODAY, minutes: 10, status: 'done', pinned: false }],
      },
      'manual_edit',
    );
    const next = run.items.find((i) => i.unitKey === 'practice:mastery:M1:1');
    expect(next?.day).toBe(addDays(TODAY, 1));
  });

  it('leaves topics a test covers to the exam plan and never displaces exam work', () => {
    const base = worked(70);
    const withFree: PlanInput = { ...base, topics: [...topics, ...free], reviewForecast: forecast(10, TODAY, addDays(TODAY, 6)) };
    const examOnly = buildPlan({ ...withFree }, 'nightly');
    const both = buildPlan({ ...withFree, masteryMinutesPerDay: 60 }, 'nightly');
    const examLines = (run: PlanRun) => lines({ ...run, items: run.items.filter((i) => i.examIds.length > 0 || i.unitType === 'vespera') });
    expect(examLines(both)).toEqual(examLines(examOnly));
    const mastery = both.items.filter((i) => i.reason.key === 'plan.reason.mastery');
    expect(mastery.every((i) => ['M1', 'M3'].includes(i.topicId ?? ''))).toBe(true);
    // Days the tests already fill past the goal get no mastery work.
    for (const d of new Set(mastery.map((i) => i.day))) {
      const exam = both.items.filter((i) => i.day === d && i.reason.key !== 'plan.reason.mastery').reduce((a, i) => a + i.minutes, 0);
      expect(exam + 10).toBeLessThan(60 + 10);
    }
  });

  it('desperate mode ignores the mastery track', () => {
    const run = buildPlan({ ...noExams(20), mode: 'desperate', desperate: { minutesPerDay: 60, coveredExamIds: [] } }, 'nightly');
    expect(run.items).toEqual([]);
  });

  it('is deterministic', () => {
    expect(lines(buildPlan(noExams(30), 'nightly'))).toEqual(lines(buildPlan(noExams(30), 'nightly')));
  });
});
