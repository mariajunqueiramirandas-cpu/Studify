// Plano até o ENEM (spec 09 ENM-07, §8.7) and Reta Final (ENM-10, §8.8). Weekly quotas instead of per-test
// deadlines: fixed units first (redações, simulados, véspera), then the week's remaining minutes split across
// LC/CH/CN/MT by area shares and filled with learn/practice units of the highest-priority ENEM topics.
// Plain data in, plain data out; the caller supplies each day's ENEM capacity (after reviews and the §8.9 share).
import type { EnemArea } from '../core/enums.ts';
import type { PlanDay } from '../planning/types.ts';
import { addDays, dayDiff, largestRemainder, weekdayMon0 } from '../planning/util.ts';
import { DEFAULT_DAY1_MIN, DEFAULT_DAY2_MIN } from './timing.ts';

export type EnemPhase = 'base' | 'intensificacao' | 'reta_final';

export const RETA_FINAL_DEFAULT_WEEKS = 4;
export const ENEM_MIN_SHARE_DEFAULT = 0.2;
/** A school test within this many days limits ENEM to `enem_min_share` (07 §8.9). */
export const SCHOOL_EXAM_WINDOW_DAYS = 14;
export const ENEM_AREAS: readonly EnemArea[] = ['LC', 'CH', 'CN', 'MT'];
export const ESSAY_MIN = 60;
export const ESSAY_REVIEW_MIN = 15;
export const AREA_SIMULADO_MIN = 135;
export const PRACTICE_MIN = 30;
export const VESPERA_AREA_MIN = 20;
export const ROLLOVER_BOOST = 1.2;
const MAX_ITEM_MIN = 240;
const LEARN_SHARE: Record<EnemPhase, number> = { base: 0.6, intensificacao: 0.3, reta_final: 0.1 };
const AREA_SHARE_FLOOR = 0.1;
/** Any Monday: anchors the simulado rotation so it does not shift between replans. */
const ROTATION_ANCHOR = '2024-01-01';

export function retaFinalStart(day1: PlanDay, weeks: number = RETA_FINAL_DEFAULT_WEEKS): PlanDay {
  return addDays(day1, -7 * Math.min(6, Math.max(2, weeks)));
}

/** ENM-07.2: Base (> 12 weeks out), Intensificação (12 → Reta Final), Reta Final (last 4 weeks, configurable). */
export function enemPhase(today: PlanDay, day1: PlanDay, retaFinalWeeks: number = RETA_FINAL_DEFAULT_WEEKS): EnemPhase {
  if (today >= retaFinalStart(day1, retaFinalWeeks)) return 'reta_final';
  return dayDiff(today, day1) > 84 ? 'base' : 'intensificacao';
}

/** 07 §8.9: ENEM keeps `minShare` of the day when a school test is within the next 14 days, else all of it. */
export function enemShareOfDay(day: PlanDay, schoolExamDates: readonly PlanDay[], minShare: number = ENEM_MIN_SHARE_DEFAULT): number {
  const near = schoolExamDates.some((d) => {
    const diff = dayDiff(day, d);
    return diff >= 0 && diff <= SCHOOL_EXAM_WINDOW_DAYS;
  });
  return near ? Math.min(1, Math.max(0, minShare)) : 1;
}

/**
 * §8.7 step 3: share_a ∝ max(0.10, w_a · gap_a) with gap_a = max(0, t_a − s_a)/100 + 0.2; without a Meta SISU
 * target w_a = 1 and t_a = s_a + 50. A missing estimate counts as 500. Normalized over LC/CH/CN/MT.
 */
export function enemAreaShares(input: { estimates?: Partial<Record<EnemArea, number>>; targets?: Partial<Record<EnemArea, number>> | null; weights?: Partial<Record<EnemArea, number>> | null }): Record<EnemArea, number> {
  const raw = ENEM_AREAS.map((a) => {
    const s = input.estimates?.[a] ?? 500;
    const hasTarget = input.targets?.[a] !== undefined && input.targets?.[a] !== null;
    const t = hasTarget ? input.targets![a]! : s + 50;
    const w = hasTarget ? (input.weights?.[a] ?? 1) : 1;
    const gap = Math.max(0, t - s) / 100 + 0.2;
    return Math.max(AREA_SHARE_FLOOR, w * gap);
  });
  const total = raw.reduce((s, x) => s + x, 0);
  return { LC: raw[0]! / total, CH: raw[1]! / total, CN: raw[2]! / total, MT: raw[3]! / total };
}

export interface EnemPlanTopic {
  enemTopicId: string;
  area: EnemArea;
  /** ENM-08.3 priority. */
  priority: number;
  mastery: number | null;
  /** The student's nodes linked to the topic; empty = no material (bank practice only, ENM-07.6). */
  nodeIds: string[];
  /** The linked nodes were already studied (no learn unit needed). */
  studied: boolean;
  /** Minutes to learn the linked nodes (0 = nothing to learn). */
  learnMinutes: number;
}

export type EnemUnitType = 'learn' | 'practice' | 'mock' | 'essay' | 'vespera';
export type EnemMockMode = 'day1' | 'day2' | 'area';

export interface EnemRolloverUnit {
  unitKey: string;
  unitType: 'learn' | 'practice';
  area: EnemArea;
  enemTopicId: string | null;
  nodeIds: string[];
  minutes: number;
  priority: number;
}

export interface EnemPlanInput {
  today: PlanDay;
  day1: PlanDay;
  /** Day 2; null = one week after Day 1. */
  day2?: PlanDay | null;
  /** ENEM minutes per day after reviews and the §8.9 share. Missing days have no capacity. */
  capacity: Record<PlanDay, number>;
  areaShares: Record<EnemArea, number>;
  topics: readonly EnemPlanTopic[];
  /** Edition start time 'HH:MM' (Reta Final simulados at the real time of day). */
  startTime?: string | null;
  day1DurationMin?: number | null;
  day2DurationMin?: number | null;
  retaFinalWeeks?: number;
  /** Weeks to plan from today's week (rolling; nightly replans extend it). */
  horizonWeeks?: number;
  /** Units already done in the current week (they count toward its quotas). */
  doneThisWeek?: { essays?: number; mocks?: number; minutesByArea?: Partial<Record<EnemArea, number>> };
  /** Units planned before today and not done: placed first this week with priority × 1.2. */
  rollover?: readonly EnemRolloverUnit[];
  /** Unit keys already done (any week): never planned again (learn units stay done for good). */
  doneKeys?: readonly string[];
}

export interface EnemPlanItem {
  id: string;
  unitKey: string;
  unitType: EnemUnitType;
  area: EnemArea | 'RED' | null;
  enemTopicId: string | null;
  nodeIds: string[];
  day: PlanDay;
  minutes: number;
  deadline: PlanDay;
  priority: number;
  orderInDay: number;
  /** Minutes from midnight when the unit must start (Reta Final simulados), else null. */
  startMin: number | null;
  mock?: { mode: EnemMockMode; area?: EnemArea; part: number; parts: number };
  reason: { key: string; params: Record<string, string | number> };
}

export interface EnemWeekSummary {
  start: PlanDay;
  end: PlanDay;
  phase: EnemPhase;
  capacityMin: number;
  plannedMin: number;
  /** Minutes of learn/practice units per area (the quota actually placed). */
  areaMinutes: Record<EnemArea, number>;
  /** The area quota before placement. */
  areaQuota: Record<EnemArea, number>;
  essays: number;
  mocks: Array<{ mode: EnemMockMode; area?: EnemArea; day: PlanDay }>;
}

export interface EnemPlanResult {
  phase: EnemPhase;
  retaFinalStart: PlanDay;
  items: EnemPlanItem[];
  weeks: EnemWeekSummary[];
  /** Unit keys that did not fit their week. */
  outOfPlan: string[];
}

interface Unit {
  unitKey: string;
  unitType: EnemUnitType;
  area: EnemArea | 'RED' | null;
  enemTopicId: string | null;
  nodeIds: string[];
  minutes: number;
  priority: number;
  reason: EnemPlanItem['reason'];
}

function mondayOf(day: PlanDay): PlanDay {
  return addDays(day, -weekdayMon0(day));
}

function hhmmToMin(hhmm: string | null | undefined): number | null {
  if (!hhmm || !/^\d{2}:\d{2}/.test(hhmm)) return null;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Splits a long unit into consecutive parts of at most 240 minutes (plan_items.minutes ≤ 240). */
function splitMinutes(total: number): number[] {
  const parts = Math.ceil(total / MAX_ITEM_MIN);
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, i) => base + (i < total - base * parts ? 1 : 0));
}

export function buildEnemPlan(input: EnemPlanInput): EnemPlanResult {
  const day1 = input.day1;
  const day2 = input.day2 ?? addDays(day1, 7);
  const rfWeeks = input.retaFinalWeeks ?? RETA_FINAL_DEFAULT_WEEKS;
  const rfStart = retaFinalStart(day1, rfWeeks);
  const horizon = Math.max(1, input.horizonWeeks ?? 4);
  const items: EnemPlanItem[] = [];
  const weeks: EnemWeekSummary[] = [];
  const outOfPlan: string[] = [];
  const learnPlanned = new Set<string>();
  const done = new Set(input.doneKeys ?? []);
  for (const key of done) if (key.startsWith('enem:learn:')) learnPlanned.add(key.slice('enem:learn:'.length));
  const durations = { day1: input.day1DurationMin ?? DEFAULT_DAY1_MIN, day2: input.day2DurationMin ?? DEFAULT_DAY2_MIN, area: AREA_SIMULADO_MIN };
  const startMin = hhmmToMin(input.startTime);

  const isExamDay = (d: PlanDay) => d === day1 || d === day2;
  const lastWeekBeforeExam = (d: PlanDay) => {
    const diff = dayDiff(d, day1);
    return diff >= 1 && diff <= 7;
  };
  const betweenDays = (d: PlanDay) => d > day1 && d < day2;

  for (let w = 0; w < horizon; w++) {
    const ws = addDays(mondayOf(input.today), 7 * w);
    if (ws > day2) break;
    const we = addDays(ws, 6);
    const days: PlanDay[] = [];
    for (let d = ws < input.today ? input.today : ws; d <= we && d <= day2; d = addDays(d, 1)) days.push(d);
    if (days.length === 0) continue;
    const phase = enemPhase(days[0]!, day1, rfWeeks);
    const remaining = new Map<PlanDay, number>(days.map((d) => [d, isExamDay(d) ? 0 : Math.max(0, Math.floor(input.capacity[d] ?? 0))]));
    const capacityMin = [...remaining.values()].reduce((s, x) => s + x, 0);
    const deadline = we < day1 ? we : addDays(day1, -1) < days[0]! ? days[days.length - 1]! : addDays(day1, -1);
    const first = w === 0;
    const summary: EnemWeekSummary = {
      start: ws,
      end: we,
      phase,
      capacityMin,
      plannedMin: 0,
      areaMinutes: { LC: 0, CH: 0, CN: 0, MT: 0 },
      areaQuota: { LC: 0, CH: 0, CN: 0, MT: 0 },
      essays: 0,
      mocks: [],
    };
    const place = (u: Unit, day: PlanDay, extra: Partial<EnemPlanItem> = {}) => {
      items.push({
        id: extra.id ?? u.unitKey,
        unitKey: u.unitKey,
        unitType: u.unitType,
        area: u.area,
        enemTopicId: u.enemTopicId,
        nodeIds: u.nodeIds,
        day,
        minutes: extra.minutes ?? u.minutes,
        deadline: extra.deadline ?? deadline,
        priority: u.priority,
        orderInDay: 0,
        startMin: extra.startMin ?? null,
        ...(extra.mock ? { mock: extra.mock } : {}),
        reason: u.reason,
      });
      remaining.set(day, (remaining.get(day) ?? 0) - (extra.minutes ?? u.minutes));
      summary.plannedMin += extra.minutes ?? u.minutes;
    };

    // ---- Véspera (§8.8): the day before each exam day is light review per area, nothing else.
    for (const [exam, areas] of [
      [day1, ['LC', 'CH', 'RED']],
      [day2, ['CN', 'MT']],
    ] as const) {
      const eve = addDays(exam, -1);
      if (!remaining.has(eve) || isExamDay(eve)) continue;
      const cap = remaining.get(eve)!;
      const per = Math.min(VESPERA_AREA_MIN, Math.floor(cap / areas.length));
      if (per >= 5) {
        for (const area of areas) {
          place(
            { unitKey: `enem:vespera:${area}:${eve}`, unitType: 'vespera', area, enemTopicId: null, nodeIds: [], minutes: per, priority: 1, reason: { key: 'enem.plan.vespera', params: { area } } },
            eve,
            { deadline: eve },
          );
        }
      }
      remaining.set(eve, 0);
    }
    // Between Day 1 and Day 2: rest first, at most 45 minutes of light CN/MT review (ENM-10.5).
    for (const d of days) if (betweenDays(d) && (remaining.get(d) ?? 0) > 45) remaining.set(d, 45);

    // ---- Simulados (ENM-07.5; Reta Final §8.8).
    const weekIdx = Math.floor(dayDiff(ROTATION_ANCHOR, ws) / 7);
    const mocks: Array<{ mode: EnemMockMode; area?: EnemArea; day?: PlanDay; startMin?: number | null }> = [];
    if (phase === 'reta_final') {
      for (const [mode, day] of [
        ['day1', addDays(day1, -14)],
        ['day2', addDays(day1, -7)],
      ] as const) {
        if (remaining.has(day)) mocks.push({ mode, day, startMin });
      }
    } else {
      // Full day every 4 weeks (alternating Dia 1 / Dia 2); an area simulado every 2 weeks on the odd weeks, so
      // the two never compete for the week's longest day.
      if (weekIdx % 4 === 0) mocks.push({ mode: (weekIdx / 4) % 2 === 0 ? 'day1' : 'day2' });
      if (weekIdx % 2 === 1) mocks.push({ mode: 'area', area: ENEM_AREAS[Math.floor(weekIdx / 2) % 4]! });
    }
    let skipMocks = first ? (input.doneThisWeek?.mocks ?? 0) : 0;
    let day1MockThisWeek = false;
    // Full days first: they need the longest day.
    for (const m of mocks) {
      if (skipMocks > 0) {
        skipMocks--;
        continue;
      }
      const minutes = durations[m.mode];
      const unitKey = `enem:mock:${m.mode}${m.area ? `:${m.area}` : ''}:${ws}`;
      let day = m.day;
      if (day !== undefined) {
        if ((remaining.get(day) ?? 0) < minutes) day = undefined;
      } else {
        // Longest available day (Sunday wins ties), never a day already holding a simulado.
        const taken = new Set(summary.mocks.map((x) => x.day));
        const candidates = days.filter((d) => !taken.has(d) && (remaining.get(d) ?? 0) >= minutes);
        candidates.sort((a, b) => (remaining.get(b) ?? 0) - (remaining.get(a) ?? 0) || Number(weekdayMon0(b) === 6) - Number(weekdayMon0(a) === 6) || a.localeCompare(b));
        day = candidates[0];
      }
      if (!day) {
        outOfPlan.push(unitKey);
        continue;
      }
      const parts = splitMinutes(minutes);
      const unit: Unit = {
        unitKey,
        unitType: 'mock',
        area: m.area ?? null,
        enemTopicId: null,
        nodeIds: [],
        minutes,
        priority: 1,
        reason: { key: m.mode === 'area' ? 'enem.plan.mock_area' : `enem.plan.mock_${m.mode}`, params: m.area ? { area: m.area } : {} },
      };
      let offset = m.startMin ?? null;
      parts.forEach((p, i) => {
        place(unit, day!, { id: parts.length > 1 ? `${unitKey}#${i + 1}` : unitKey, minutes: p, deadline: day, startMin: offset, mock: { mode: m.mode, ...(m.area ? { area: m.area } : {}), part: i + 1, parts: parts.length } });
        if (offset !== null) offset += p;
      });
      summary.mocks.push({ mode: m.mode, ...(m.area ? { area: m.area } : {}), day });
      if (m.mode === 'day1') day1MockThisWeek = true;
    }

    // ---- Redações (ENM-07.4): 1 per week, 2 in the last 8 weeks; the Dia 1 simulado includes one.
    let essays = dayDiff(ws, day1) <= 56 ? 2 : 1;
    if (day1MockThisWeek) essays -= 1;
    const essaysDone = first ? (input.doneThisWeek?.essays ?? 0) : 0;
    essays -= essaysDone;
    const essayDays = new Set<PlanDay>(summary.mocks.map((m) => m.day));
    // Numbering continues after the essays already done, so a done unit key is never reused.
    for (let n = essaysDone + 1; n <= essaysDone + essays; n++) {
      const unitKey = `enem:essay:${ws}:${n}`;
      const candidates = days.filter((d) => !essayDays.has(d) && !betweenDays(d) && (remaining.get(d) ?? 0) >= ESSAY_MIN + ESSAY_REVIEW_MIN);
      candidates.sort((a, b) => (remaining.get(b) ?? 0) - (remaining.get(a) ?? 0) || a.localeCompare(b));
      const day = candidates[0];
      if (!day) {
        outOfPlan.push(unitKey);
        continue;
      }
      essayDays.add(day);
      place({ unitKey, unitType: 'essay', area: 'RED', enemTopicId: null, nodeIds: [], minutes: ESSAY_MIN, priority: 1, reason: { key: 'enem.plan.essay', params: {} } }, day);
      // The feedback review: the next day with room, else the same day.
      const next = days.find((d) => d > day && !betweenDays(d) && (remaining.get(d) ?? 0) >= ESSAY_REVIEW_MIN) ?? day;
      place({ unitKey: `enem:essay_review:${ws}:${n}`, unitType: 'essay', area: 'RED', enemTopicId: null, nodeIds: [], minutes: ESSAY_REVIEW_MIN, priority: 1, reason: { key: 'enem.plan.essay_review', params: {} } }, next);
      summary.essays += 1;
    }

    // ---- Area quotas for the remaining minutes.
    const free = [...remaining.values()].reduce((s, x) => s + Math.max(0, x), 0);
    const doneByArea = first ? (input.doneThisWeek?.minutesByArea ?? {}) : {};
    const doneTotal = ENEM_AREAS.reduce((s, a) => s + (doneByArea[a] ?? 0), 0);
    const slots = largestRemainder(
      Math.floor((free + doneTotal) / 5),
      ENEM_AREAS.map((a) => input.areaShares[a] ?? 0),
    );
    const quota: Record<EnemArea, number> = { LC: 0, CH: 0, CN: 0, MT: 0 };
    ENEM_AREAS.forEach((a, i) => (quota[a] = Math.max(0, slots[i]! * 5 - (doneByArea[a] ?? 0))));
    summary.areaQuota = { ...quota };

    const units: Unit[] = [];
    if (first) {
      for (const r of input.rollover ?? []) {
        units.push({ unitKey: r.unitKey, unitType: r.unitType, area: r.area, enemTopicId: r.enemTopicId, nodeIds: r.nodeIds, minutes: r.minutes, priority: r.priority * ROLLOVER_BOOST, reason: { key: 'enem.plan.rollover', params: { area: r.area } } });
        quota[r.area] = Math.max(0, quota[r.area] - r.minutes);
        if (r.unitType === 'learn' && r.enemTopicId) learnPlanned.add(r.enemTopicId);
      }
    }
    const learnAllowedWeek = !days.every((d) => lastWeekBeforeExam(d) || isExamDay(d) || betweenDays(d));
    for (const area of ENEM_AREAS) {
      const topics = input.topics.filter((t) => t.area === area).sort((a, b) => b.priority - a.priority || a.enemTopicId.localeCompare(b.enemTopicId));
      let budget = quota[area];
      let learnBudget = Math.floor(budget * LEARN_SHARE[phase]);
      // Reta Final: learn only for the area's top-quartile topics with mastery < 0.5 (§8.8).
      const topQuartile = new Set(topics.slice(0, Math.max(1, Math.ceil(topics.length / 4))).map((t) => t.enemTopicId));
      for (const t of topics) {
        if (!learnAllowedWeek || learnBudget <= 0) break;
        if (learnPlanned.has(t.enemTopicId) || t.studied || t.nodeIds.length === 0 || t.learnMinutes <= 0) continue;
        if (phase === 'reta_final' && (!topQuartile.has(t.enemTopicId) || (t.mastery ?? 0) >= 0.5)) continue;
        const minutes = Math.min(60, Math.ceil(t.learnMinutes / 5) * 5);
        if (minutes > learnBudget) continue;
        units.push({ unitKey: `enem:learn:${t.enemTopicId}`, unitType: 'learn', area, enemTopicId: t.enemTopicId, nodeIds: t.nodeIds, minutes, priority: t.priority, reason: { key: 'enem.plan.learn', params: { area } } });
        learnPlanned.add(t.enemTopicId);
        learnBudget -= minutes;
        budget -= minutes;
      }
      // Practice: one list per topic by priority, then a second for topics still under 0.6.
      const rounds: Array<{ suffix: string; topics: EnemPlanTopic[] }> = [
        { suffix: 'practice', topics },
        { suffix: 'practice2', topics: topics.filter((t) => (t.mastery ?? 0) < 0.6) },
      ];
      for (const round of rounds) {
        for (const t of round.topics) {
          if (budget < 15) break;
          const minutes = budget >= PRACTICE_MIN ? PRACTICE_MIN : Math.floor(budget / 5) * 5;
          units.push({
            unitKey: `enem:${round.suffix}:${t.enemTopicId}:${ws}`,
            unitType: 'practice',
            area,
            enemTopicId: t.enemTopicId,
            nodeIds: t.nodeIds,
            minutes,
            priority: t.priority * (round.suffix === 'practice2' ? 0.8 : 1),
            reason: { key: round.suffix === 'practice2' ? 'enem.plan.practice2' : 'enem.plan.practice', params: { area, source: t.nodeIds.length > 0 ? 'material' : 'bank' } },
          });
          budget -= minutes;
        }
      }
      // Minutes the topic lists did not use (or no taxonomy yet): area-level bank lists of mixed topics.
      for (let n = 1; budget >= 15; n++) {
        const minutes = budget >= PRACTICE_MIN ? PRACTICE_MIN : Math.floor(budget / 5) * 5;
        units.push({ unitKey: `enem:practice:${area}:${ws}:${n}`, unitType: 'practice', area, enemTopicId: null, nodeIds: [], minutes, priority: 0.01, reason: { key: 'enem.plan.practice', params: { area, source: 'bank' } } });
        budget -= minutes;
      }
    }

    // ---- Placement: highest priority first, on the day with the most room (earliest on ties).
    units.sort((a, b) => b.priority - a.priority || a.unitKey.localeCompare(b.unitKey));
    for (const u of units) {
      if (done.has(u.unitKey)) continue;
      const allowed = (d: PlanDay) => {
        if (u.unitType === 'learn' && (lastWeekBeforeExam(d) || betweenDays(d))) return false;
        if (betweenDays(d) && u.area !== 'CN' && u.area !== 'MT') return false;
        return true;
      };
      const roomiest = days.filter(allowed).sort((a, b) => (remaining.get(b) ?? 0) - (remaining.get(a) ?? 0) || a.localeCompare(b))[0];
      const room = roomiest ? (remaining.get(roomiest) ?? 0) : 0;
      // A practice list is flexible: it shrinks to the room left (≥ 15 min) instead of dropping out.
      const minutes = room >= u.minutes ? u.minutes : u.unitType === 'practice' && room >= 15 ? Math.floor(room / 5) * 5 : 0;
      if (!roomiest || minutes === 0) {
        outOfPlan.push(u.unitKey);
        continue;
      }
      place({ ...u, minutes }, roomiest);
      if (u.area && u.area !== 'RED') summary.areaMinutes[u.area] += minutes;
    }
    weeks.push(summary);
  }

  // Order inside each day: timed simulados first, then essays, then by priority.
  const rank: Record<EnemUnitType, number> = { mock: 0, vespera: 1, essay: 2, learn: 3, practice: 4 };
  const byDay = new Map<PlanDay, EnemPlanItem[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  for (const list of byDay.values()) {
    list.sort((a, b) => rank[a.unitType] - rank[b.unitType] || (a.mock?.part ?? 0) - (b.mock?.part ?? 0) || b.priority - a.priority || a.id.localeCompare(b.id));
    list.forEach((it, i) => (it.orderInDay = i));
  }
  items.sort((a, b) => a.day.localeCompare(b.day) || a.orderInDay - b.orderInDay);
  return { phase: enemPhase(input.today, day1, rfWeeks), retaFinalStart: rfStart, items, weeks, outOfPlan };
}

export type RetaFinalNotice = 'reta_final_start' | 'eve' | 'exam_day' | 'between_days';

/**
 * ENM-10 notifications for a local day: the Reta Final start card, the evening before each exam day, the exam-day
 * good-luck message (the only notification that day) and the between-days rest message. Null = nothing.
 */
export function retaFinalNotice(day: PlanDay, day1: PlanDay, day2: PlanDay | null, retaFinalWeeks: number = RETA_FINAL_DEFAULT_WEEKS): RetaFinalNotice | null {
  const d2 = day2 ?? addDays(day1, 7);
  if (day === day1 || day === d2) return 'exam_day';
  if (day === addDays(day1, -1) || day === addDays(d2, -1)) return 'eve';
  if (day > day1 && day < d2) return 'between_days';
  if (day === retaFinalStart(day1, retaFinalWeeks)) return 'reta_final_start';
  return null;
}
