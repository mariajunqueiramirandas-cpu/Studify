// GOL-04 planner — `buildPlan` (spec 07 §8.2, learning-engine §11). Pure and deterministic:
// same input → same output, no clock, no randomness. Desperate mode (GOL-12, §11.13) runs here too.
import type {
  AttackGroup,
  MaterialKind,
  PlanDay,
  PlanDayLoad,
  PlanExam,
  PlanInput,
  PlanItem,
  PlanItemState,
  PlanRun,
  PlanSettings,
  PlanTopic,
  PlanTriageStep,
  PlanUnitKind,
  PlanPreviousItem,
  ReplanTrigger,
} from './types.ts';
import { attackCoverage, planAttack, type AttackTopic } from './desperate.ts';
import { addDays, ceil5, clamp, dayDiff, EPS, fnv1a32, stableStringify, weekdayMon0 } from './util.ts';

/** Default study minutes Mon…Sun (open decision D-15: 60 on weekdays, 90 on weekends; editable). */
export const DEFAULT_AVAILABILITY_MINUTES: readonly number[] = [60, 60, 60, 60, 60, 90, 90];

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  maxBlockMin: 30,
  minBlockMin: 10,
  maxSubjectsPerDay: 3,
  windowStartMin: 8 * 60,
  windowEndMin: 22 * 60,
  pace: 1,
  testDayFactor: 0.5,
  reviewCapFactor: 0.6,
};

const LEARN_MIN_PER_PAGE: Record<MaterialKind, number> = { slides: 1.5, notes: 3, textbook: 4, other: 3 };

/** Upper bound of est_learn_minutes from the page formula alone (spec 07 §8.2.2). */
const FORMULA_MAX_MINUTES = 90;
/** Upper bound when the model estimated the time from the pages themselves: dense material can need more. */
const ESTIMATE_MAX_MINUTES = 180;

/**
 * est_learn_minutes(n) (spec 07 §8.2.2): Σ over the topic's sources of the model's estimate for that source when it
 * has one (ingest.topicDetail read the pages), else pages × f(kind); clamped to 10–90 (formula only) or 10–180.
 */
export function estLearnMinutes(sources: ReadonlyArray<{ kind: MaterialKind; pages: number; minutes?: number | null }>): number {
  let estimated = false;
  const raw = sources.reduce((acc, s) => {
    if (typeof s.minutes === 'number' && s.minutes > 0) {
      estimated = true;
      return acc + s.minutes;
    }
    return acc + s.pages * (LEARN_MIN_PER_PAGE[s.kind] ?? 3);
  }, 0);
  return clamp(raw, 10, estimated ? ESTIMATE_MAX_MINUTES : FORMULA_MAX_MINUTES);
}

/** Stable hash of the canonical input and trigger (stored as plan_runs.input_hash). */
export function planInputHash(input: PlanInput, trigger: ReplanTrigger): string {
  return fnv1a32(stableStringify({ input, trigger }));
}

/** Internal kinds: `practice2` is the second practice of a topic, emitted as `practice` with a `practice2:` key. */
type Kind = PlanUnitKind | 'practice2';

const KIND_RANK: Record<Kind, number> = {
  learn: 1,
  learn_light: 1,
  upload_material: 1,
  practice: 2,
  practice2: 3,
  mock: 4,
  vespera: 5,
  warmup: 6,
};

const REASON_KEY: Record<Kind, string> = {
  learn: 'plan.reason.learn',
  learn_light: 'plan.reason.learn_light',
  upload_material: 'plan.reason.upload',
  practice: 'plan.reason.practice',
  practice2: 'plan.reason.practice2',
  mock: 'plan.reason.mock',
  vespera: 'plan.reason.vespera',
  warmup: 'plan.reason.warmup',
};

/** A logical unit (learn(n), practice(n), mock(e), …) before it is cut into blocks. */
interface Unit {
  key: string;
  kind: Kind;
  examIds: string[];
  /** Test that owns the unit for pacing (earliest deadline; ties by id). */
  primaryExam: string;
  topicId: string | null;
  subjectId: string | null;
  mapOrder: number;
  minutes: number;
  earliest: PlanDay;
  /** Effective deadline, clamped to [today, D − 1]. */
  deadline: PlanDay;
  dependsOn: string | null;
  sameDayAfterDep: boolean;
  priority: number;
  /** Mock blocks are exempt from the 1.5 × q soft cap (§11.5 step 3). */
  exemptFromCap: boolean;
  reasonParams: Record<string, string | number>;
  tie: string;
}

interface Block extends Unit {
  id: string;
}

interface FixedItem {
  id: string;
  unitKey: string;
  kind: Kind;
  examIds: string[];
  topicId: string | null;
  day: PlanDay;
  minutes: number;
  deadline: PlanDay;
  priority: number;
  status: PlanItemState;
  pinned: boolean;
  reasonParams: Record<string, string | number>;
  mapOrder: number;
}

interface Prepared {
  today: PlanDay;
  settings: PlanSettings;
  desperate: boolean;
  exams: PlanExam[];
  examById: Map<string, PlanExam>;
  topicsOf: Map<string, PlanTopic[]>;
  omega: Map<string, Map<string, number>>;
  weightNorm: Map<string, number>;
  rho: Map<string, number>;
  readiness: Map<string, number>;
  covered: Set<string>;
  groups: Record<string, AttackGroup>;
  topicById: Map<string, PlanTopic>;
  days: PlanDay[];
  A: Map<PlanDay, number>;
  R: Map<PlanDay, number>;
  cap: Map<PlanDay, number>;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function examOrder(a: PlanExam, b: PlanExam): number {
  return a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : compareIds(a.id, b.id);
}

function topicOrder(a: PlanTopic, b: PlanTopic): number {
  return a.order - b.order || compareIds(a.id, b.id);
}

/** Candidate order (§11.5 step 3): earliest deadline → higher π → unit kind → map order → id. */
function cmpCandidate(a: Unit, b: Unit): number {
  if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.mapOrder !== b.mapOrder) return a.mapOrder - b.mapOrder;
  return compareIds(a.tie, b.tie);
}

/** Triage order (§11.5 step 2): lowest π first; ties → the topic later in map order goes first. */
function cmpTriage(a: Unit, b: Unit): number {
  return a.priority - b.priority || b.mapOrder - a.mapOrder || compareIds(a.key, b.key);
}

function effectiveDay(raw: PlanDay, today: PlanDay): PlanDay {
  return raw < today ? today : raw;
}

function kindOf(p: PlanPreviousItem): Kind {
  return p.unitKey.startsWith('practice2:') ? 'practice2' : p.unitType;
}

function avail(input: PlanInput, d: PlanDay): number {
  const ex = input.availability.exceptions?.[d];
  if (ex !== undefined) return Math.max(0, ex);
  return Math.max(0, input.availability.minutesByWeekday[weekdayMon0(d)] ?? 0);
}

/** Vespera minutes for one test day: 25 default, +10 per extra test on the same date, max 40 (GOL-07.1, GOL-07.4). */
export function vesperaMinutesForTests(count: number): number {
  return Math.min(40, 25 + 10 * Math.max(0, count - 1));
}

// ---------------------------------------------------------------- unit creation (§11.2, §11.4)

function buildUnits(
  p: Prepared,
  doneDay: Map<string, PlanDay>,
  doneKeys: Set<string>,
  mockFixedIds: Set<string>,
): Unit[] {
  const units = new Map<string, Unit>();
  const put = (u: Unit): void => {
    if (units.has(u.key)) throw new Error(`duplicate unit key ${u.key}`);
    units.set(u.key, u);
  };

  // Serving records per topic: which tests want it, in which group, at which priority.
  interface Serving {
    exam: PlanExam;
    covered: boolean;
    group: AttackGroup | undefined;
    pi: number;
    m: number;
    omega: number;
  }
  const servings = new Map<string, { topic: PlanTopic; list: Serving[] }>();
  for (const e of p.exams) {
    const omega = p.omega.get(e.id) ?? new Map<string, number>();
    const W = p.weightNorm.get(e.id) ?? 1;
    const rho = p.rho.get(e.id) ?? 0.5;
    const covered = p.covered.has(e.id);
    for (const t of p.topicsOf.get(e.id) ?? []) {
      const m = t.mastery ?? 0;
      const w = omega.get(t.id) ?? 0;
      const pi = W * w * (1 - m) * (1 + rho) * (t.overconfident ? 1.15 : 1);
      let group: AttackGroup | undefined;
      if (covered) group = p.groups[t.id] ?? 'out';
      const entry = servings.get(t.id) ?? { topic: t, list: [] };
      entry.list.push({ exam: e, covered, group, pi, m, omega: w });
      servings.set(t.id, entry);
    }
  }

  for (const { topic: t, list } of [...servings.values()].sort((a, b) => topicOrder(a.topic, b.topic))) {
    // Out topics of covered tests get nothing from those tests (GOL-12.6). Other tests still count.
    const relevant = list.filter((s) => !(s.covered && s.group === 'out'));
    if (relevant.length === 0) continue;
    const examIds = relevant.map((s) => s.exam.id).sort(compareIds);
    const maxPi = Math.max(...relevant.map((s) => s.pi));
    const nearest = relevant.slice().sort((a, b) => a.exam.localDate < b.exam.localDate ? -1 : a.exam.localDate > b.exam.localDate ? 1 : compareIds(a.exam.id, b.exam.id))[0];
    const primary = nearest?.exam.id ?? examIds[0] ?? '';

    if (t.isPlaceholder) {
      // GOL-03.4: a placeholder topic only needs material (5 min, due D − 3).
      const deadlineRaw = relevant
        .map((s) => addDays(s.exam.localDate, -3))
        .sort()[0] ?? p.today;
      put({
        key: `upload:${t.id}`,
        kind: 'upload_material',
        examIds,
        primaryExam: primary,
        topicId: t.id,
        subjectId: t.subjectId,
        mapOrder: t.order,
        minutes: 5,
        earliest: p.today,
        deadline: effectiveDay(deadlineRaw, p.today),
        dependsOn: null,
        sameDayAfterDep: false,
        priority: maxPi,
        exemptFromCap: false,
        reasonParams: { topic: t.id },
        tie: `upload:${t.id}`,
      });
      continue;
    }

    const allLight = relevant.every((s) => s.covered && (s.group === 'focus' || s.group === 'basic'));
    const learnKey = `learn:${t.id}`;
    if (!t.studied && !doneKeys.has(learnKey)) {
      const minutesFull = Math.ceil(estLearnMinutes(t.sources) * (t.pace ?? p.settings.pace) - EPS);
      const deadlineRaw = relevant.map((s) => addDays(s.exam.localDate, -2)).sort()[0] ?? p.today;
      put({
        key: learnKey,
        kind: allLight ? 'learn_light' : 'learn',
        examIds,
        primaryExam: primary,
        topicId: t.id,
        subjectId: t.subjectId,
        mapOrder: t.order,
        minutes: allLight ? Math.ceil(minutesFull / 2) : minutesFull,
        earliest: p.today,
        deadline: effectiveDay(deadlineRaw, p.today),
        dependsOn: null,
        sameDayAfterDep: false,
        priority: maxPi,
        exemptFromCap: false,
        reasonParams: { topic: t.id },
        tie: learnKey,
      });
    }

    for (const s of relevant) {
      // Só o básico gets learn_light only (GOL-12.6).
      if (s.covered && s.group === 'basic') continue;
      const practiceKey = `practice:${s.exam.id}:${t.id}`;
      const practiceParams = { topic: t.id, exam: s.exam.title, masteryPct: Math.round(s.m * 100) };
      const practiceDone = doneKeys.has(practiceKey);
      if (s.m < 0.8 && !practiceDone) {
        put({
          key: practiceKey,
          kind: 'practice',
          examIds: [s.exam.id],
          primaryExam: s.exam.id,
          topicId: t.id,
          subjectId: t.subjectId,
          mapOrder: t.order,
          minutes: 10,
          earliest: p.today,
          deadline: effectiveDay(addDays(s.exam.localDate, -1), p.today),
          dependsOn: !t.studied ? learnKey : null,
          // GOL-12.6: in desperate mode practice may follow the same day's learning.
          sameDayAfterDep: s.covered,
          priority: s.pi,
          exemptFromCap: false,
          reasonParams: practiceParams,
          tie: practiceKey,
        });
      }
      // Second practice after a completed first one while mastery is still < 0.6 (§11.2). Desperate focus topics get it too.
      const p2Key = `practice2:${s.exam.id}:${t.id}`;
      if (s.m < 0.6 && !doneKeys.has(p2Key)) {
        const done = doneDay.get(practiceKey);
        if (!s.covered && done !== undefined) {
          put({
            key: p2Key,
            kind: 'practice2',
            examIds: [s.exam.id],
            primaryExam: s.exam.id,
            topicId: t.id,
            subjectId: t.subjectId,
            mapOrder: t.order,
            minutes: 10,
            earliest: effectiveDay(addDays(done, 1), p.today),
            deadline: effectiveDay(addDays(s.exam.localDate, -1), p.today),
            dependsOn: null,
            sameDayAfterDep: false,
            priority: s.pi,
            exemptFromCap: false,
            reasonParams: practiceParams,
            tie: p2Key,
          });
        } else if (s.covered && s.group === 'focus' && s.m < 0.6) {
          put({
            key: p2Key,
            kind: 'practice2',
            examIds: [s.exam.id],
            primaryExam: s.exam.id,
            topicId: t.id,
            subjectId: t.subjectId,
            mapOrder: t.order,
            minutes: 10,
            earliest: p.today,
            deadline: effectiveDay(addDays(s.exam.localDate, -1), p.today),
            dependsOn: practiceKey,
            sameDayAfterDep: true,
            priority: s.pi,
            exemptFromCap: false,
            reasonParams: practiceParams,
            tie: p2Key,
          });
        }
      }
    }
  }

  // Mock per test (§11.2): min(45, 3·|N_e| + 15), earliest D − 4, deadline D − 1. Desperate covered tests use the fixed mini-simulado instead.
  for (const e of p.exams) {
    const mockKey = `mock:${e.id}`;
    // Covered desperate tests get the 20-min mini-simulado (fixed) or none (GOL-12.6).
    if (mockFixedIds.has(mockKey) || p.covered.has(e.id)) continue;
    const n = (p.topicsOf.get(e.id) ?? []).length;
    const W = p.weightNorm.get(e.id) ?? 1;
    const rho = p.rho.get(e.id) ?? 0.5;
    const readiness = p.readiness.get(e.id) ?? 0;
    put({
      key: mockKey,
      kind: 'mock',
      examIds: [e.id],
      primaryExam: e.id,
      topicId: null,
      subjectId: e.subjectId,
      mapOrder: 1_000_000 + p.exams.findIndex((x) => x.id === e.id),
      minutes: Math.min(45, 3 * n + 15),
      earliest: effectiveDay(addDays(e.localDate, -4), p.today),
      deadline: effectiveDay(addDays(e.localDate, -1), p.today),
      dependsOn: null,
      sameDayAfterDep: false,
      // Units without a node: ω = 1, m = readiness_e (§11.4).
      priority: W * (1 - readiness) * (1 + rho),
      exemptFromCap: true,
      reasonParams: { exam: e.title, masteryPct: Math.round(readiness * 100) },
      tie: mockKey,
    });
  }

  return [...units.values()];
}

// ---------------------------------------------------------------- blocks, placement (§11.2, §11.5)

function expandBlocks(units: Unit[], maxBlock: number, minBlock: number): Block[] {
  const out: Block[] = [];
  for (const u of units.slice().sort((a, b) => compareIds(a.key, b.key))) {
    const m = Math.max(0, Math.round(u.minutes));
    if (m === 0) continue;
    const parts: number[] = [];
    if (m <= maxBlock) {
      parts.push(m);
    } else {
      const full = Math.floor(m / maxBlock);
      for (let i = 0; i < full; i++) parts.push(maxBlock);
      const rest = m - full * maxBlock;
      if (rest > 0) {
        if (rest < minBlock) parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + rest;
        else parts.push(rest);
      }
    }
    parts.forEach((minutes, i) => {
      const id = parts.length === 1 ? u.key : `${u.key}#${i}`;
      out.push({ ...u, id, tie: id, minutes });
    });
  }
  return out;
}

interface PlaceResult {
  placed: Map<string, { block: Block; day: PlanDay }>;
  unplaced: Block[];
  remaining: Map<PlanDay, number>;
  lastDay: Map<string, PlanDay>;
}

/**
 * Pass 1 (pacing) places each test's available units up to q_e(d) = ceil(remaining_e / (D_e − 1 − d + 1)).
 * Pass 2 fills the rest of C(d) by earliest deadline, skipping candidates that break a soft constraint
 * (subjects per day, two blocks of one subject in a row, 1.5 × q_e for one test unless exempt).
 */
function place(blocks: Block[], p: Prepared): PlaceResult {
  const sorted = blocks.slice().sort(cmpCandidate);
  const placed = new Map<string, { block: Block; day: PlanDay }>();
  const remaining = new Map<PlanDay, number>(p.cap);
  const keyLeft = new Map<string, number>();
  for (const b of sorted) keyLeft.set(b.key, (keyLeft.get(b.key) ?? 0) + 1);
  const lastDay = new Map<string, PlanDay>();
  // Pacing order: earliest D_e − 1 first, then id.
  const examOrderList = p.exams
    .map((e) => ({ e, due: addDays(e.localDate, -1) }))
    .sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : compareIds(a.e.id, b.e.id)))
    .map((x) => x.e);

  const isAvailable = (b: Block, d: PlanDay): boolean => {
    if (placed.has(b.id)) return false;
    if (b.earliest > d || b.deadline < d) return false;
    if (b.dependsOn !== null && keyLeft.has(b.dependsOn)) {
      if ((keyLeft.get(b.dependsOn) ?? 0) > 0) return false;
      const dd = lastDay.get(b.dependsOn);
      if (dd === undefined) return false;
      if (dd > d || (dd === d && !b.sameDayAfterDep)) return false;
    }
    return true;
  };

  for (const d of p.days) {
    let cap = remaining.get(d) ?? 0;
    const remainingByExam = new Map<string, number>();
    for (const b of sorted) {
      if (placed.has(b.id)) continue;
      remainingByExam.set(b.primaryExam, (remainingByExam.get(b.primaryExam) ?? 0) + b.minutes);
    }
    const quota = new Map<string, number>();
    for (const e of examOrderList) {
      const rem = remainingByExam.get(e.id) ?? 0;
      const span = Math.max(1, dayDiff(d, addDays(e.localDate, -1)) + 1);
      quota.set(e.id, Math.ceil(rem / span - EPS));
    }

    const examMin = new Map<string, number>();
    const subjects = new Set<string>();
    const todayOrder: Block[] = [];
    const commit = (b: Block): void => {
      placed.set(b.id, { block: b, day: d });
      cap -= b.minutes;
      examMin.set(b.primaryExam, (examMin.get(b.primaryExam) ?? 0) + b.minutes);
      if (b.subjectId !== null) subjects.add(b.subjectId);
      keyLeft.set(b.key, (keyLeft.get(b.key) ?? 1) - 1);
      lastDay.set(b.key, d);
      todayOrder.push(b);
    };

    // Pass 1 — pacing.
    for (const e of examOrderList) {
      const qe = quota.get(e.id) ?? 0;
      for (const b of sorted) {
        if (b.primaryExam !== e.id || !isAvailable(b, d)) continue;
        if ((examMin.get(e.id) ?? 0) + b.minutes > qe + EPS || b.minutes > cap) continue;
        commit(b);
      }
    }

    // Pass 2 — EDF fill with soft constraints. Repeats while a same-day dependency unlocks new candidates.
    const violatesSoft = (b: Block): boolean => {
      const used = examMin.get(b.primaryExam) ?? 0;
      const qe = quota.get(b.primaryExam) ?? 0;
      if (!b.exemptFromCap && used > 0 && used + b.minutes > 1.5 * qe + EPS) return true;
      if (b.subjectId !== null && !subjects.has(b.subjectId) && subjects.size >= p.settings.maxSubjectsPerDay) return true;
      if (
        b.subjectId !== null &&
        todayOrder.length >= 2 &&
        todayOrder.slice(-2).every((x) => x.subjectId === b.subjectId)
      ) {
        return true;
      }
      return false;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of sorted) {
        if (!isAvailable(b, d) || b.minutes > cap) continue;
        if (violatesSoft(b)) continue;
        commit(b);
        changed = true;
      }
    }
    remaining.set(d, cap);
  }

  const unplaced = sorted.filter((b) => !placed.has(b.id));
  return { placed, unplaced, remaining, lastDay };
}

/** Aggregate feasibility (§11.5 step 1): work with deadline ≤ x must fit in Σ C(d) for d ∈ [today, x]. */
function aggregateFeasible(blocks: Block[], p: Prepared): boolean {
  const deadlines = [...new Set(blocks.map((b) => b.deadline))].sort();
  for (const x of deadlines) {
    const work = blocks.filter((b) => b.deadline <= x).reduce((a, b) => a + b.minutes, 0);
    let capacity = 0;
    for (const d of p.days) {
      if (d > x) break;
      capacity += p.cap.get(d) ?? 0;
    }
    if (work > capacity + EPS) return false;
  }
  return true;
}

/** Dependency rule: a practice follows its learn on a later day (same day only in desperate mode). */
function depAllows(b: Block, d: PlanDay, res: PlaceResult, blocks: Block[]): boolean {
  if (b.dependsOn === null) return true;
  const dep = blocks.filter((x) => x.key === b.dependsOn);
  if (dep.length === 0) return true;
  if (dep.some((x) => !res.placed.has(x.id))) return false;
  const dd = res.lastDay.get(b.dependsOn);
  if (dd === undefined) return false;
  return dd < d || (dd === d && b.sameDayAfterDep);
}

function commit(b: Block, d: PlanDay, res: PlaceResult): void {
  res.placed.set(b.id, { block: b, day: d });
  res.remaining.set(d, (res.remaining.get(d) ?? 0) - b.minutes);
  res.lastDay.set(b.key, maxDay(res, b.key));
}

function maxDay(res: PlaceResult, key: string): PlanDay {
  let best = '';
  for (const { block, day } of res.placed.values()) if (block.key === key && day > best) best = day;
  return best;
}

/** Blocks that may move later to make room (mocks, uploads, practices nobody depends on). */
const MOVABLE: ReadonlySet<Kind> = new Set<Kind>(['mock', 'practice', 'practice2', 'upload_material']);

/**
 * Places one unplaced block directly, or by moving one movable block later to free its slot
 * (§11.5 step 5a). Returns true when the block was placed.
 */
function fitBlock(b: Block, res: PlaceResult, blocks: Block[], days: PlanDay[]): boolean {
  for (const d of days) {
    if (d < b.earliest || d > b.deadline) continue;
    if (!depAllows(b, d, res, blocks)) continue;
    if ((res.remaining.get(d) ?? 0) < b.minutes) continue;
    commit(b, d, res);
    return true;
  }
  const candidates = [...res.placed.values()].map((x) => x.block).sort((x, y) => (x.id < y.id ? -1 : 1));
  for (const v of candidates) {
    const dv = res.placed.get(v.id)?.day;
    if (dv === undefined || !MOVABLE.has(v.kind)) continue;
    if (blocks.some((x) => x.dependsOn === v.key)) continue;
    if (dv < b.earliest || dv > b.deadline || !depAllows(b, dv, res, blocks)) continue;
    if ((res.remaining.get(dv) ?? 0) + v.minutes < b.minutes) continue;
    for (const dw of days) {
      if (dw <= dv || dw > v.deadline || dw < v.earliest) continue;
      if ((res.remaining.get(dw) ?? 0) < v.minutes) continue;
      res.placed.delete(v.id);
      res.remaining.set(dv, (res.remaining.get(dv) ?? 0) + v.minutes);
      commit(v, dw, res);
      commit(b, dv, res);
      return true;
    }
  }
  return false;
}

/** Tries to place every unplaced block with `fitBlock`; returns the blocks still unplaced. */
function repairByMoves(res: PlaceResult, blocks: Block[], p: Prepared): Block[] {
  for (const b of res.unplaced.slice().sort(cmpCandidate)) {
    if (!res.placed.has(b.id)) fitBlock(b, res, blocks, p.days);
  }
  res.unplaced = res.unplaced.filter((b) => !res.placed.has(b.id));
  return res.unplaced;
}

// ---------------------------------------------------------------- triage (§11.5 step 2)

function unitsServing(units: Map<string, Unit>, examId: string): number {
  let n = 0;
  for (const u of units.values()) if (u.examIds.includes(examId)) n++;
  return n;
}

function canDrop(units: Map<string, Unit>, u: Unit): boolean {
  // Never drop the last remaining unit of a test (step 2e).
  return u.examIds.every((e) => unitsServing(units, e) > 1);
}

function applyNextTriage(units: Map<string, Unit>, triage: PlanTriageStep[], outOfPlan: string[]): boolean {
  const list = [...units.values()];
  const pick = (pred: (u: Unit) => boolean): Unit[] => list.filter(pred).sort(cmpTriage);

  for (const u of pick((x) => x.kind === 'practice2')) {
    if (!canDrop(units, u)) continue;
    units.delete(u.key);
    triage.push({ step: 'drop_practice2', unitKey: u.key, topicId: u.topicId });
    return true;
  }
  for (const u of pick((x) => x.kind === 'learn')) {
    u.kind = 'learn_light';
    u.minutes = Math.ceil(u.minutes / 2);
    u.reasonParams = { ...u.reasonParams };
    triage.push({ step: 'downgrade_learn', unitKey: u.key, topicId: u.topicId });
    return true;
  }
  for (const u of pick((x) => x.kind === 'mock' && x.minutes > 20)) {
    u.minutes = 20;
    triage.push({ step: 'shorten_mock', unitKey: u.key, topicId: null });
    return true;
  }
  for (const u of pick((x) => x.kind === 'learn_light')) {
    if (!canDrop(units, u)) continue;
    units.delete(u.key);
    outOfPlan.push(u.key);
    triage.push({ step: 'drop_learn_light', unitKey: u.key, topicId: u.topicId });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- main entry

/**
 * Builds the plan for `input` under `trigger`. Done and pinned items never move; items before the
 * replan start stay where they are; everything else is placed again (§8.2.6).
 */
export function buildPlan(input: PlanInput, trigger: ReplanTrigger): PlanRun {
  const settings: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, ...(input.settings ?? {}) };
  const today = input.today;
  const desperate = input.mode === 'desperate';
  const excludedExams: PlanRun['excludedExams'] = [];

  const active: PlanExam[] = [];
  for (const e of input.exams.slice().sort(examOrder)) {
    if (e.status !== 'scheduled') {
      excludedExams.push({ examId: e.id, reason: 'not_scheduled' });
      continue;
    }
    if (dayDiff(today, e.localDate) < 1) {
      excludedExams.push({ examId: e.id, reason: 'too_close' });
      continue;
    }
    active.push(e);
  }
  const examById = new Map(active.map((e) => [e.id, e]));

  const topicById = new Map<string, PlanTopic>();
  for (const t of input.topics.slice().sort(topicOrder)) topicById.set(t.id, t);
  const topicsOf = new Map<string, PlanTopic[]>();
  for (const e of active) {
    const seen = new Set<string>();
    const list: PlanTopic[] = [];
    for (const id of e.scopeTopicIds) {
      const t = topicById.get(id);
      if (t !== undefined && !seen.has(id)) {
        seen.add(id);
        list.push(t);
      }
    }
    topicsOf.set(e.id, list.sort(topicOrder));
  }

  // Horizon: today … last test date (units are due on D − 1 at the latest).
  const horizonEnd = active.reduce<PlanDay>((acc, e) => (e.localDate > acc ? e.localDate : acc), today);
  const days: PlanDay[] = [];
  for (let d = today; dayDiff(d, horizonEnd) >= 0; d = addDays(d, 1)) days.push(d);

  // Replan start (§8.2.6). Past pending items return to the pool (nightly rule).
  const replanFrom =
    trigger === 'nightly' || trigger === 'exam_changed'
      ? today
      : trigger === 'manual_edit'
        ? (input.editedDay ?? today)
        : input.sessionStartedToday
          ? addDays(today, 1)
          : today;

  const fixed: FixedItem[] = [];
  const fixedIds = new Set<string>();
  const skipped: string[] = [];
  const doneDay = new Map<string, PlanDay>();
  const prevById = new Map<string, PlanPreviousItem>();
  const previous = (input.previous ?? []).slice().sort((a, b) => compareIds(a.id, b.id));
  const fixedFrom = (prev: PlanPreviousItem): FixedItem => {
    const kind = kindOf(prev);
    return {
      id: prev.id,
      unitKey: prev.unitKey,
      kind,
      examIds: prev.examIds.slice().sort(compareIds),
      topicId: prev.topicId,
      day: prev.day,
      minutes: prev.minutes,
      deadline: prev.deadline ?? prev.day,
      priority: prev.priority ?? 0,
      status: prev.status,
      pinned: prev.pinned,
      reasonParams: {},
      mapOrder: 0,
    };
  };
  for (const prev of previous) {
    prevById.set(prev.id, prev);
    if (prev.status === 'done') {
      fixed.push(fixedFrom(prev));
      fixedIds.add(prev.id);
      if (prev.unitKey.startsWith('practice:')) {
        const cur = doneDay.get(prev.unitKey);
        if (cur === undefined || prev.day > cur) doneDay.set(prev.unitKey, prev.day);
      }
      continue;
    }
    if (prev.status === 'skipped') continue;
    if (prev.day < today) {
      skipped.push(prev.unitKey);
      continue;
    }
    if (prev.pinned || prev.day < replanFrom) {
      fixed.push(fixedFrom(prev));
      fixedIds.add(prev.id);
    }
  }

  // Vespera (fixed, D − 1, GOL-07). One per test date.
  const byDate = new Map<PlanDay, PlanExam[]>();
  for (const e of active) byDate.set(e.localDate, [...(byDate.get(e.localDate) ?? []), e]);
  for (const [date, list] of [...byDate.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    const id = `vespera:${date}`;
    if (fixedIds.has(id)) continue;
    const day = addDays(date, -1);
    fixed.push({
      id,
      unitKey: id,
      kind: 'vespera',
      examIds: list.map((e) => e.id).sort(compareIds),
      topicId: null,
      day,
      minutes: vesperaMinutesForTests(list.length),
      deadline: day,
      priority: 0,
      status: 'planned',
      pinned: false,
      reasonParams: { tests: list.length },
      mapOrder: 2_000_000,
    });
    fixedIds.add(id);
  }

  // Desperate mini-simulado: 20 min on D − 2 when the test is ≥ 3 days away (GOL-12.6).
  const covered = new Set<string>();
  if (desperate) {
    for (const id of input.desperate?.coveredExamIds ?? []) if (examById.has(id)) covered.add(id);
    for (const e of active) {
      if (!covered.has(e.id) || dayDiff(today, e.localDate) < 3) continue;
      const id = `mock:${e.id}`;
      if (fixedIds.has(id)) continue;
      fixed.push({
        id,
        unitKey: id,
        kind: 'mock',
        examIds: [e.id],
        topicId: null,
        day: addDays(e.localDate, -2),
        minutes: 20,
        deadline: addDays(e.localDate, -2),
        priority: 0,
        status: 'planned',
        pinned: false,
        reasonParams: { exam: e.title },
        mapOrder: 3_000_000,
      });
      fixedIds.add(id);
    }
  }

  // Availability A(d), reviews R(d), capacity C(d) (§11.3).
  const fixedMinOn = new Map<PlanDay, number>();
  for (const f of fixed) fixedMinOn.set(f.day, (fixedMinOn.get(f.day) ?? 0) + f.minutes);
  const testDays = new Set(active.map((e) => e.localDate));
  const lastCovered = [...covered].reduce<PlanDay>(
    (acc, id) => {
      const d = examById.get(id)?.localDate ?? acc;
      return d > acc ? d : acc;
    },
    today,
  );
  const windowLen = Math.max(0, settings.windowEndMin - settings.windowStartMin);
  const A = new Map<PlanDay, number>();
  const R = new Map<PlanDay, number>();
  const cap = new Map<PlanDay, number>();
  const reviewOverflow: PlanDay[] = [];
  for (const d of days) {
    let a = avail(input, d);
    // GOL-12.4: the answer overrides available minutes until the last covered test (planned ≤ 240, ≤ 5/6 of the window for 25 + 5 blocks).
    if (covered.size > 0 && dayDiff(d, lastCovered) >= 1) {
      const ex = input.availability.exceptions?.[d];
      a = ex === 0 ? 0 : Math.min(input.desperate?.minutesPerDay ?? 0, 240, Math.floor((windowLen * 5) / 6));
    }
    A.set(d, a);
    const raw = input.reviewForecast?.[d] ?? 0;
    const reserved = Math.min(ceil5(raw), Math.floor(settings.reviewCapFactor * a));
    R.set(d, reserved);
    if (raw > 0 && raw > Math.floor(settings.reviewCapFactor * a)) reviewOverflow.push(d);
    let c = Math.max(0, a - reserved);
    if (testDays.has(d)) c = Math.floor(c * settings.testDayFactor);
    cap.set(d, Math.max(0, c - (fixedMinOn.get(d) ?? 0)));
  }

  // Priorities inputs: W', ρ, ω, readiness (§11.4, §8.6).
  const maxW = active.reduce((acc, e) => Math.max(acc, e.weight), 0);
  const weightNorm = new Map(active.map((e) => [e.id, maxW > 0 ? e.weight / maxW : 1] as const));
  const rho = new Map(active.map((e) => [e.id, e.requiredRatio ?? 0.5] as const));
  const omega = new Map<string, Map<string, number>>();
  const readiness = new Map<string, number>();
  for (const e of active) {
    const list = topicsOf.get(e.id) ?? [];
    const raw = list.map((t) => Math.max(0, e.topicWeights?.[t.id] ?? estLearnMinutes(t.sources)));
    const sum = raw.reduce((a, b) => a + b, 0);
    const map = new Map<string, number>();
    list.forEach((t, i) => map.set(t.id, sum > 0 ? (raw[i] ?? 0) / sum : 1 / Math.max(1, list.length)));
    omega.set(e.id, map);
    let r = 0;
    for (const t of list) r += (map.get(t.id) ?? 0) * (t.studied ? 1 : 0) * (t.mastery ?? 0);
    readiness.set(e.id, r);
  }

  // Plano de ataque (desperate, §8.10.2): groups from planAttack unless the caller supplies them.
  let groups: Record<string, AttackGroup> = {};
  let attack: PlanRun['attack'];
  if (desperate && covered.size > 0) {
    if (input.desperate?.groups !== undefined) {
      groups = { ...input.desperate.groups };
    } else {
      const capacity = days
        .filter((d) => dayDiff(d, lastCovered) >= 1)
        .reduce((acc, d) => acc + (cap.get(d) ?? 0), 0);
      const agg = new Map<string, AttackTopic>();
      for (const id of covered) {
        for (const t of topicsOf.get(id) ?? []) {
          if (t.isPlaceholder) continue;
          const w = omega.get(id)?.get(t.id) ?? 0;
          const gain = (weightNorm.get(id) ?? 1) * w * (1 - (t.mastery ?? 0));
          const cur = agg.get(t.id);
          if (cur) cur.gain += gain;
          else
            agg.set(t.id, {
              id: t.id,
              order: t.order,
              learnMin: estLearnMinutes(t.sources) * (t.pace ?? settings.pace),
              gain,
            });
        }
      }
      groups = planAttack([...agg.values()], capacity, input.desperate?.userMoves ?? {}).groups;
    }
    const omegaCovered: Record<string, Record<string, number>> = {};
    for (const id of [...covered].sort(compareIds)) {
      omegaCovered[id] = Object.fromEntries(omega.get(id) ?? []);
    }
    attack = { groups, coverage: attackCoverage(groups, omegaCovered) };
  }

  const prepared: Prepared = {
    today,
    settings,
    desperate,
    exams: active,
    examById,
    topicsOf,
    omega,
    weightNorm,
    rho,
    readiness,
    covered,
    groups,
    topicById,
    days,
    A,
    R,
    cap,
  };

  // Units and their blocks, with triage and placement (§11.5).
  const mockFixedIds = new Set(fixed.filter((f) => f.kind === 'mock').map((f) => f.unitKey));
  const doneKeys = new Set(previous.filter((p) => p.status === 'done').map((p) => p.unitKey));
  const units = new Map<string, Unit>(
    buildUnits(prepared, doneDay, doneKeys, mockFixedIds)
      .filter((u) => !fixedIds.has(u.key))
      .map((u) => [u.key, u]),
  );
  // Blocks whose id was fixed (done, pinned, or before the replan start) are not placed again.
  const blockFilter = (b: Block): boolean => !fixedIds.has(b.id);
  const maxBlock = desperate ? Math.min(25, settings.maxBlockMin) : settings.maxBlockMin;
  const triage: PlanTriageStep[] = [];
  const outOfPlan: string[] = [];
  let blocks: Block[] = [];
  let result: PlaceResult = { placed: new Map(), unplaced: [], remaining: new Map(), lastDay: new Map() };
  for (let guard = 0; guard < 2000; guard++) {
    blocks = expandBlocks([...units.values()], maxBlock, settings.minBlockMin).filter(blockFilter);
    // Triage while the aggregate check fails (§11.5 steps 1–2) …
    if (!aggregateFeasible(blocks, prepared) && applyNextTriage(units, triage, outOfPlan)) continue;
    // … then place; leftovers that do not fit block by block get the move repair (step 5a).
    result = place(blocks, prepared);
    if (result.unplaced.length > 0) repairByMoves(result, blocks, prepared);
    if (result.unplaced.length === 0) break;
    if (!applyNextTriage(units, triage, outOfPlan)) break;
  }

  // Final repair (step 5): ≤ 15 min over capacity on the deadline day, otherwise "fora do plano".
  const tight: string[] = [];
  for (const b of repairByMoves(result, blocks, prepared)) {
    const day = effectiveDay(b.deadline, today);
    if (depAllows(b, day, result, blocks) && (result.remaining.get(day) ?? 0) + 15 >= b.minutes) {
      commit(b, day, result);
      tight.push(b.id);
    } else if (!outOfPlan.includes(b.key)) {
      outOfPlan.push(b.key);
    }
  }

  // Assemble items. Fixed items keep their state; placed blocks become `planned`.
  const items: PlanItem[] = [];
  const toItem = (
    base: Omit<PlanItem, 'orderInDay' | 'startMin' | 'endMin'>,
  ): PlanItem => ({ ...base, orderInDay: 0, startMin: 0, endMin: 0 });
  for (const f of fixed) {
    items.push(
      toItem({
        id: f.id,
        unitKey: f.unitKey,
        unitType: f.kind === 'practice2' ? 'practice' : f.kind,
        examIds: f.examIds,
        topicId: f.topicId,
        day: f.day,
        minutes: f.minutes,
        deadline: f.deadline,
        priority: clean6(f.priority),
        demanding: f.kind === 'learn' || f.kind === 'mock',
        pinned: f.pinned,
        status: f.status,
        reason: { key: REASON_KEY[f.kind], params: f.reasonParams },
      }),
    );
  }
  for (const { block: b, day } of result.placed.values()) {
    items.push(
      toItem({
        id: b.id,
        unitKey: b.key,
        unitType: b.kind === 'practice2' ? 'practice' : b.kind,
        examIds: b.examIds,
        topicId: b.topicId,
        day,
        minutes: b.minutes,
        deadline: b.deadline,
        priority: clean6(b.priority),
        demanding: b.kind === 'learn' || b.kind === 'mock',
        pinned: false,
        status: 'planned',
        reason: { key: REASON_KEY[b.kind], params: b.reasonParams },
      }),
    );
  }
  items.sort(
    (a, b) =>
      compareIds(a.day, b.day) ||
      itemRank(a) - itemRank(b) ||
      compareIds(a.deadline, b.deadline) ||
      b.priority - a.priority ||
      compareIds(a.id, b.id),
  );

  // Order and layout inside each day: reviews first (reserved minutes), then the items in order.
  const breakMin = desperate ? 5 : 0;
  const byDay = new Map<PlanDay, PlanItem[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  for (const [d, list] of [...byDay.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    let cursor = settings.windowStartMin + (R.get(d) ?? 0);
    list.forEach((it, i) => {
      it.orderInDay = i;
      it.startMin = cursor;
      it.endMin = cursor + it.minutes;
      cursor = it.endMin + breakMin;
    });
  }

  // Moved minutes against the previous assignment (GOL-04.5: "Reorganizei seu plano" at ≥ 15).
  let movedMinutes = 0;
  for (const it of items) {
    const prev = prevById.get(it.id);
    if (prev !== undefined && prev.status === 'planned' && !fixedIds.has(it.id) && prev.day !== it.day) {
      movedMinutes += it.minutes;
    }
  }

  const dayLoads: PlanDayLoad[] = days.map((d) => ({
    day: d,
    availableMin: A.get(d) ?? 0,
    reviewMin: R.get(d) ?? 0,
    capacityMin: cap.get(d) ?? 0,
    plannedMin: items.filter((it) => it.day === d).reduce((acc, it) => acc + it.minutes, 0),
  }));

  const outUnique = [...new Set(outOfPlan)].sort(compareIds);
  return {
    trigger,
    inputHash: planInputHash(input, trigger),
    items,
    days: dayLoads,
    feasible: triage.length === 0 && tight.length === 0 && outUnique.length === 0,
    triage,
    tight: tight.sort(compareIds),
    outOfPlan: outUnique,
    skipped: [...new Set(skipped)].sort(compareIds),
    reviewOverflow,
    excludedExams,
    movedMinutes,
    reorganized: movedMinutes >= 15,
    ...(attack !== undefined ? { attack } : {}),
  };
}

/** Day order (§11.5 step 4): reviews → learn → practice → practice₂ → mock → vespera. */
function itemRank(it: PlanItem): number {
  if (it.unitKey.startsWith('practice2:')) return KIND_RANK.practice2;
  return KIND_RANK[it.unitType];
}

function clean6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
