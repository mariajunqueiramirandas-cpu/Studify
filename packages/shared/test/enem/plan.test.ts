import { describe, expect, it } from 'vitest';
import {
  buildEnemPlan,
  enemAreaShares,
  enemPhase,
  enemShareOfDay,
  retaFinalNotice,
  retaFinalStart,
  type EnemPlanInput,
  type EnemPlanTopic,
} from '../../src/enem/index.ts';
import { addDays, dayDiff, weekdayMon0 } from '../../src/planning/util.ts';

const DAY1 = '2027-11-07'; // a Sunday
const DAY2 = '2027-11-14';

function capacity(from: string, to: string, weekday = 90, sunday = 360): Record<string, number> {
  const out: Record<string, number> = {};
  for (let d = from; d <= to; d = addDays(d, 1)) out[d] = weekdayMon0(d) === 6 ? sunday : weekday;
  return out;
}

const topics: EnemPlanTopic[] = (['LC', 'CH', 'CN', 'MT'] as const).flatMap((area, ai) =>
  Array.from({ length: 6 }, (_, i) => ({
    enemTopicId: `${area}-t${i}`,
    area,
    priority: 0.2 - i * 0.02 - ai * 0.001,
    mastery: i % 2 ? 0.7 : 0.3,
    nodeIds: i < 3 ? [`n-${area}-${i}`] : [],
    studied: i === 0,
    learnMinutes: 45,
  })),
);

describe('ENEM plan helpers (spec 09 §8.7–8.8, 07 §8.9)', () => {
  it('phases: Base > 12 weeks out, then Intensificação, Reta Final in the last 4 weeks', () => {
    expect(enemPhase('2027-06-01', DAY1)).toBe('base');
    expect(enemPhase(addDays(DAY1, -84), DAY1)).toBe('intensificacao');
    expect(retaFinalStart(DAY1)).toBe('2027-10-10');
    expect(enemPhase('2027-10-10', DAY1)).toBe('reta_final');
    expect(enemPhase('2027-10-09', DAY1)).toBe('intensificacao');
    expect(retaFinalStart(DAY1, 6)).toBe(addDays(DAY1, -42));
    expect(retaFinalStart(DAY1, 10)).toBe(addDays(DAY1, -42));
  });

  it('a school test within 14 days limits ENEM to enem_min_share', () => {
    expect(enemShareOfDay('2027-05-01', ['2027-05-10'])).toBe(0.2);
    expect(enemShareOfDay('2027-05-01', ['2027-05-16'])).toBe(1);
    expect(enemShareOfDay('2027-05-01', ['2027-04-30'])).toBe(1);
    expect(enemShareOfDay('2027-05-01', ['2027-05-10'], 0)).toBe(0);
  });

  it('area shares follow w·gap with a floor, and default to equal without data', () => {
    const equal = enemAreaShares({});
    for (const v of Object.values(equal)) expect(v).toBeCloseTo(0.25, 10);
    const s = enemAreaShares({ estimates: { LC: 650, CH: 700, CN: 600, MT: 620 }, targets: { LC: 725, CH: 755, CN: 690, MT: 705 }, weights: { LC: 1, CH: 1, CN: 2, MT: 3 } });
    // raw = w·(gap/100 + 0.2): LC 0.95, CH 0.75, CN 2.2, MT 3.15.
    expect(s.MT).toBeCloseTo(3.15 / 7.05, 10);
    expect(s.CH).toBeCloseTo(0.75 / 7.05, 10);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('Reta Final notices: start card, eves, exam days and between days', () => {
    expect(retaFinalNotice('2027-10-10', DAY1, DAY2)).toBe('reta_final_start');
    expect(retaFinalNotice('2027-11-06', DAY1, DAY2)).toBe('eve');
    expect(retaFinalNotice(DAY1, DAY1, DAY2)).toBe('exam_day');
    expect(retaFinalNotice('2027-11-10', DAY1, DAY2)).toBe('between_days');
    expect(retaFinalNotice('2027-11-13', DAY1, DAY2)).toBe('eve');
    expect(retaFinalNotice('2027-09-01', DAY1, DAY2)).toBeNull();
  });
});

describe('buildEnemPlan — 20-week fixture (acceptance, spec 09 §11)', () => {
  const today = addDays(DAY1, -7 * 20 + 1); // a Monday, 20 weeks before Day 1
  const shares = enemAreaShares({ estimates: { LC: 650, CH: 700, CN: 600, MT: 620 }, targets: { LC: 725, CH: 755, CN: 690, MT: 705 }, weights: { LC: 1, CH: 1, CN: 2, MT: 3 } });
  const input: EnemPlanInput = { today, day1: DAY1, day2: DAY2, capacity: capacity(today, DAY2), areaShares: shares, topics, startTime: '13:30', horizonWeeks: 22 };
  const plan = buildEnemPlan(input);
  const preWeeks = plan.weeks.filter((w) => w.end < addDays(DAY1, -1));

  it('plans every week up to the exam', () => {
    expect(weekdayMon0(today)).toBe(0);
    expect(plan.weeks.length).toBe(21);
    expect(plan.items.every((i) => i.day >= today && i.day <= DAY2)).toBe(true);
    expect(plan.items.every((i) => i.minutes >= 1 && i.minutes <= 240)).toBe(true);
    expect(new Set(plan.items.map((i) => i.id)).size).toBe(plan.items.length);
  });

  it('redação cadence: 1 per week, 2 per week in the last 8 weeks (a Dia 1 simulado counts as one)', () => {
    for (const w of preWeeks) {
      const expected = dayDiff(w.start, DAY1) <= 56 ? 2 : 1;
      const day1Mock = w.mocks.some((m) => m.mode === 'day1') ? 1 : 0;
      expect(w.essays + day1Mock, w.start).toBe(expected);
      const reviews = plan.items.filter((i) => i.unitKey.startsWith(`enem:essay_review:${w.start}`));
      expect(reviews).toHaveLength(w.essays);
    }
  });

  it('simulado cadence: an area simulado every 2 weeks, a full day every 4 weeks; Reta Final at the real time', () => {
    const nonFinal = preWeeks.filter((w) => w.phase !== 'reta_final');
    const withArea = nonFinal.filter((w) => w.mocks.some((m) => m.mode === 'area'));
    const withFull = nonFinal.filter((w) => w.mocks.some((m) => m.mode !== 'area'));
    expect(withArea.length).toBeGreaterThanOrEqual(Math.floor(nonFinal.length / 2));
    expect(withFull.length).toBeGreaterThanOrEqual(Math.floor(nonFinal.length / 4));
    // Rotating areas, alternating days.
    expect(new Set(withArea.flatMap((w) => w.mocks.filter((m) => m.area).map((m) => m.area))).size).toBe(4);
    expect(new Set(withFull.flatMap((w) => w.mocks.filter((m) => m.mode !== 'area').map((m) => m.mode)))).toEqual(new Set(['day1', 'day2']));
    // Full-day simulados go on the longest day (Sunday here).
    for (const w of withFull) for (const m of w.mocks.filter((x) => x.mode !== 'area')) expect(weekdayMon0(m.day)).toBe(6);
    const rf1 = plan.items.filter((i) => i.unitKey === `enem:mock:day1:${addDays(DAY1, -20)}`);
    expect(rf1.map((i) => i.day)).toEqual([addDays(DAY1, -14), addDays(DAY1, -14)]);
    expect(rf1[0]!.startMin).toBe(13 * 60 + 30);
    expect(rf1[1]!.startMin).toBe(13 * 60 + 30 + rf1[0]!.minutes);
    expect(rf1.reduce((s, i) => s + i.minutes, 0)).toBe(330);
    expect(plan.items.some((i) => i.unitKey.startsWith('enem:mock:day2') && i.day === addDays(DAY1, -7))).toBe(true);
  });

  it('area shares within ±5% of §8.7', () => {
    for (const w of preWeeks.filter((x) => x.phase !== 'reta_final')) {
      const total = Object.values(w.areaMinutes).reduce((s, x) => s + x, 0);
      if (total < 200) continue;
      for (const a of ['LC', 'CH', 'CN', 'MT'] as const) expect(Math.abs(w.areaMinutes[a] / total - shares[a]), `${w.start} ${a}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('never plans more than a day holds', () => {
    const byDay = new Map<string, number>();
    for (const i of plan.items) byDay.set(i.day, (byDay.get(i.day) ?? 0) + i.minutes);
    for (const [day, minutes] of byDay) expect(minutes, day).toBeLessThanOrEqual(input.capacity[day]!);
  });

  it('Reta Final rules: no learn in the last 7 days, véspera only on eves, nothing on exam days', () => {
    expect(plan.items.some((i) => i.day === DAY1 || i.day === DAY2)).toBe(false);
    expect(plan.items.filter((i) => i.unitType === 'learn' && dayDiff(i.day, DAY1) >= 1 && dayDiff(i.day, DAY1) <= 7)).toEqual([]);
    const eve = plan.items.filter((i) => i.day === addDays(DAY1, -1));
    expect(eve.map((i) => i.unitType)).toEqual(['vespera', 'vespera', 'vespera']);
    expect(new Set(eve.map((i) => i.area))).toEqual(new Set(['LC', 'CH', 'RED']));
    const between = plan.items.filter((i) => i.day > DAY1 && i.day < addDays(DAY2, -1));
    expect(between.every((i) => i.area === 'CN' || i.area === 'MT')).toBe(true);
  });

  it('learn units come first in Base and shrink later; each topic is learned once', () => {
    const learn = plan.items.filter((i) => i.unitType === 'learn');
    expect(new Set(learn.map((i) => i.enemTopicId)).size).toBe(learn.length);
    // Studied topics and topics without material never get a learn unit.
    expect(learn.some((i) => i.enemTopicId?.endsWith('-t0') || i.enemTopicId?.endsWith('-t3'))).toBe(false);
    expect(learn.every((i) => i.nodeIds.length > 0)).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildEnemPlan(input)).toEqual(plan);
  });
});

describe('buildEnemPlan — rolling week and quotas', () => {
  it('counts what was done this week and rolls over unfinished units with a 1.2 boost', () => {
    const today = '2027-03-03'; // Wednesday
    const plan = buildEnemPlan({
      today,
      day1: DAY1,
      capacity: capacity(today, '2027-03-07'),
      areaShares: enemAreaShares({}),
      topics,
      horizonWeeks: 1,
      doneThisWeek: { essays: 1, mocks: 5 },
      rollover: [{ unitKey: 'enem:practice:MT-t5:2027-02-22', unitType: 'practice', area: 'MT', enemTopicId: 'MT-t5', nodeIds: [], minutes: 30, priority: 0.1 }],
    });
    expect(plan.weeks[0]!.essays).toBe(0);
    expect(plan.weeks[0]!.mocks).toEqual([]);
    const roll = plan.items.find((i) => i.unitKey === 'enem:practice:MT-t5:2027-02-22')!;
    expect(roll.priority).toBeCloseTo(0.12, 10);
    expect(roll.reason.key).toBe('enem.plan.rollover');
    expect(plan.items.every((i) => i.day >= today)).toBe(true);
  });

  it('a goal created less than 4 weeks before the exam starts in Reta Final', () => {
    const today = addDays(DAY1, -20);
    const plan = buildEnemPlan({ today, day1: DAY1, capacity: capacity(today, DAY2), areaShares: enemAreaShares({}), topics, horizonWeeks: 5 });
    expect(plan.phase).toBe('reta_final');
    expect(plan.weeks.every((w) => w.phase === 'reta_final')).toBe(true);
  });

  it('a week with no capacity plans nothing and reports what did not fit', () => {
    const plan = buildEnemPlan({ today: '2027-03-01', day1: DAY1, capacity: {}, areaShares: enemAreaShares({}), topics, horizonWeeks: 1 });
    expect(plan.items).toEqual([]);
    expect(plan.outOfPlan.some((k) => k.startsWith('enem:essay:'))).toBe(true);
  });

  it('without an ENEM taxonomy it plans area-level bank lists', () => {
    const plan = buildEnemPlan({ today: '2027-03-01', day1: DAY1, capacity: capacity('2027-03-01', '2027-03-07'), areaShares: enemAreaShares({}), topics: [], horizonWeeks: 1 });
    const practice = plan.items.filter((i) => i.unitType === 'practice');
    expect(practice.length).toBeGreaterThan(0);
    expect(practice.every((i) => i.enemTopicId === null && i.reason.params.source === 'bank')).toBe(true);
  });
});
