// Wellbeing (WEL-01 focus timer, WEL-03 burnout guard; learning-engine §20, spec 13 §8.8–8.10). Everything here
// runs on the device: the focus timeline drives the countdown and the burnout guard reads local activity only.
import { mean, median } from './util.ts';

// ---------- WEL-01 Modo foco ----------

export interface FocusConfig {
  focusMin: number;
  breakMin: number;
  cycles: number;
}

export const FOCUS_PRESETS: ReadonlyArray<{ id: '25_5' | '50_10'; config: FocusConfig }> = [
  { id: '25_5', config: { focusMin: 25, breakMin: 5, cycles: 4 } },
  { id: '50_10', config: { focusMin: 50, breakMin: 10, cycles: 2 } },
];

/** WEL-01.1 custom limits; a long break follows every 4th cycle. WEL-02.4: app blocking covers at most 3 h. */
export const FOCUS_LIMITS = {
  focusMin: [10, 90],
  breakMin: [3, 30],
  cycles: [1, 6],
  longBreakEvery: 4,
  longBreakMax: 30,
  blockingMaxMin: 180,
} as const;

export function validateFocusConfig(c: FocusConfig): string[] {
  const errors: string[] = [];
  const within = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!within(c.focusMin, FOCUS_LIMITS.focusMin)) errors.push('focus_min');
  if (!within(c.breakMin, FOCUS_LIMITS.breakMin)) errors.push('break_min');
  if (!within(c.cycles, FOCUS_LIMITS.cycles)) errors.push('cycles');
  return errors;
}

export interface FocusPhase {
  kind: 'focus' | 'break' | 'long_break';
  cycle: number;
  minutes: number;
}

/** The timeline: focus, break, focus, … with a long break (3× the break, ≤ 30 min) after every 4th cycle. No trailing break. */
export function focusPhases(c: FocusConfig): FocusPhase[] {
  const out: FocusPhase[] = [];
  for (let i = 1; i <= c.cycles; i++) {
    out.push({ kind: 'focus', cycle: i, minutes: c.focusMin });
    if (i === c.cycles) break;
    const long = i % FOCUS_LIMITS.longBreakEvery === 0;
    out.push({ kind: long ? 'long_break' : 'break', cycle: i, minutes: long ? Math.min(FOCUS_LIMITS.longBreakMax, c.breakMin * 3) : c.breakMin });
  }
  return out;
}

export function focusTotalMinutes(c: FocusConfig): number {
  return focusPhases(c).reduce((s, p) => s + p.minutes, 0);
}

/** WEL-02.4: blocking ends automatically and never covers more than 3 h. */
export function blockingAllowed(c: FocusConfig): boolean {
  return focusTotalMinutes(c) <= FOCUS_LIMITS.blockingMaxMin;
}

export interface FocusPosition {
  index: number;
  phase: FocusPhase | null;
  /** Milliseconds left in the current phase (0 when done). */
  remainingMs: number;
  done: boolean;
}

export interface FocusWindow {
  phase: FocusPhase;
  /** Running time (pauses excluded) at which the phase starts and ends. */
  start: number;
  end: number;
}

/**
 * Each phase's span in running time, with `skippedAtMs` phases ended early: skipping a phase moves its end to the
 * moment of the skip, and each skip ends exactly one phase (the one running at that moment).
 */
export function focusPhaseWindows(phases: readonly FocusPhase[], skippedAtMs: readonly number[] = []): FocusWindow[] {
  const out: FocusWindow[] = [];
  const skips = [...skippedAtMs].sort((a, b) => a - b);
  let start = 0;
  let next = 0;
  for (const phase of phases) {
    let end = start + phase.minutes * 60_000;
    while (next < skips.length && skips[next]! < start) next++;
    if (next < skips.length && skips[next]! < end) end = Math.max(start, skips[next++]!);
    out.push({ phase, start, end });
    start = end;
  }
  return out;
}

/** Where a session is after `elapsedMs` of running time (pauses already excluded by the caller). */
export function focusPositionAt(phases: readonly FocusPhase[], elapsedMs: number, skippedAtMs: readonly number[] = []): FocusPosition {
  for (const [index, w] of focusPhaseWindows(phases, skippedAtMs).entries()) {
    if (elapsedMs < w.end) return { index, phase: w.phase, remainingMs: w.end - elapsedMs, done: false };
  }
  return { index: phases.length, phase: null, remainingMs: 0, done: true };
}

/**
 * WEL-01.6 credited focus time: the parts of `intervals` (running time, e.g. while the student was on Studify or,
 * for a plan item, had the screen off) that fall inside focus phases and before `untilMs`.
 */
export function focusCreditedMs(
  phases: readonly FocusPhase[],
  skippedAtMs: readonly number[],
  intervals: ReadonlyArray<readonly [number, number]>,
  untilMs: number,
): number {
  const focus = focusPhaseWindows(phases, skippedAtMs).filter((w) => w.phase.kind === 'focus');
  // Merge overlapping intervals first so time is never counted twice.
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...intervals].map(([a, b]) => [Math.max(0, a), Math.min(untilMs, b)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let total = 0;
  for (const w of focus) for (const [a, b] of merged) total += Math.max(0, Math.min(w.end, b) - Math.max(w.start, a));
  return total;
}

/** Focus cycles fully completed (each one earns XP, spec 13 §8.1). */
export function completedFocusCycles(phases: readonly FocusPhase[], position: FocusPosition): number {
  return phases.slice(0, position.index).filter((p) => p.kind === 'focus').length;
}

// ---------- WEL-03 burnout guard ----------

export type BurnoutNudgeKind = 'long_session' | 'daily_load' | 'late_night' | 'performance_drop' | 'overload_trend' | 'checkin_low';

export const BURNOUT = {
  longSessionMin: 50,
  longSessionRepeatMin: 90,
  breakResetMin: 5,
  dailyLoadFloorMin: 180,
  lateNightMin: 10,
  lateNightStart: 23 * 60,
  examEveLateNightStart: 22 * 60 + 30,
  lateNightEnd: 5 * 60,
  dropWindow: 20,
  dropPoints: 0.25,
  dropTimeFactor: 1.5,
  overloadDays: 6,
  overloadFactor: 1.5,
  perKindPerDay: 1,
  perDay: 2,
} as const;

export interface BurnoutInput {
  /** Local minutes since midnight. */
  minuteOfDay: number;
  /** Weekday of the calendar date the current night started on: 0 = Sunday … 6 = Saturday. */
  nightWeekday: number;
  examEve: boolean;
  dailyGoalMinutes: number;
  todayActiveMinutes: number;
  /** Active minutes since the last break of ≥ 5 min. */
  continuousMinutes: number;
  inFocusTimer: boolean;
  /** Duel, battle or simulado running: nudges wait until it ends. */
  inTimedActivity: boolean;
  lateNightMinutesTonight: number;
  /** Items answered in the current session, in order. */
  sessionItems: ReadonlyArray<{ correct: boolean; ms: number }>;
  /** The last 7 study days, oldest first. */
  last7: ReadonlyArray<{ activeMinutes: number; accuracy: number | null }>;
  /** Weekly check-in answers (1 = lowest … 5), oldest first. */
  checkins: readonly number[];
  /** Nudges already shown today by kind; long_session counts each of its two steps. */
  shownToday: Readonly<Partial<Record<BurnoutNudgeKind, number>>>;
  lateNightShownTonight: boolean;
  nudgesEnabled: boolean;
}

export interface BurnoutNudge {
  kind: BurnoutNudgeKind;
  /** long_session at 90 min uses the stronger wording. */
  strong?: boolean;
  /** overload_trend offers "Rebalancear plano" (WEL-03.3); checkin_low shows the help card (WEL-03.4). */
  action?: 'rebalance' | 'help_card';
}

/** Least-squares slope of the accuracies over their day index (null when fewer than 4 days have one). */
function accuracySlope(days: BurnoutInput['last7']): number | null {
  const pts = days.flatMap((d, i) => (d.accuracy === null ? [] : [[i, d.accuracy] as const]));
  if (pts.length < 4) return null;
  const mx = mean(pts.map((p) => p[0]))!;
  const my = mean(pts.map((p) => p[1]))!;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function isLateNight(minuteOfDay: number, examEve: boolean): boolean {
  const start = examEve ? BURNOUT.examEveLateNightStart : BURNOUT.lateNightStart;
  return minuteOfDay >= start || minuteOfDay < BURNOUT.lateNightEnd;
}

/**
 * The nudges to show now (spec 13 §8.10), at most one, honoring WEL-03.2: one per heuristic per day (long_session
 * may repeat once at 90 min), two per day overall, never during a timed activity. Check-in low ignores the toggle
 * and the cap: it carries the help card, which stays available (WEL-03.2/.5).
 */
export function burnoutNudges(input: BurnoutInput): BurnoutNudge[] {
  if (input.inTimedActivity) return [];
  const out: BurnoutNudge[] = [];
  const cs = input.checkins;
  if (cs.length >= 2 && cs[cs.length - 1] === 1 && cs[cs.length - 2] === 1 && !input.shownToday.checkin_low) {
    out.push({ kind: 'checkin_low', action: 'help_card' });
  }
  if (!input.nudgesEnabled) return out;
  const shownTotal = Object.entries(input.shownToday)
    .filter(([k]) => k !== 'checkin_low')
    .reduce((s, [, v]) => s + (v ?? 0), 0);
  if (shownTotal >= BURNOUT.perDay) return out;
  const shown = (k: BurnoutNudgeKind) => input.shownToday[k] ?? 0;

  const candidates: BurnoutNudge[] = [];
  const schoolNight = input.nightWeekday >= 0 && input.nightWeekday <= 4; // Sun–Thu
  if (
    schoolNight &&
    !input.lateNightShownTonight &&
    isLateNight(input.minuteOfDay, input.examEve) &&
    input.lateNightMinutesTonight >= BURNOUT.lateNightMin
  ) {
    candidates.push({ kind: 'late_night' });
  }
  if (!input.inFocusTimer) {
    if (input.continuousMinutes >= BURNOUT.longSessionRepeatMin && shown('long_session') === 1) candidates.push({ kind: 'long_session', strong: true });
    else if (input.continuousMinutes >= BURNOUT.longSessionMin && shown('long_session') === 0) candidates.push({ kind: 'long_session' });
  }
  const items = input.sessionItems;
  if (items.length >= BURNOUT.dropWindow * 2 && !shown('performance_drop')) {
    const first = items.slice(0, BURNOUT.dropWindow);
    const last = items.slice(-BURNOUT.dropWindow);
    const acc = (xs: typeof items) => xs.filter((x) => x.correct).length / xs.length;
    const slower = (median(last.map((x) => x.ms)) ?? 0) >= BURNOUT.dropTimeFactor * (median(first.map((x) => x.ms)) ?? Infinity);
    if (acc(first) - acc(last) >= BURNOUT.dropPoints - 1e-9 || slower) candidates.push({ kind: 'performance_drop' });
  }
  if (!shown('daily_load') && input.todayActiveMinutes > Math.max(2 * input.dailyGoalMinutes, BURNOUT.dailyLoadFloorMin)) {
    candidates.push({ kind: 'daily_load' });
  }
  if (!shown('overload_trend') && input.dailyGoalMinutes > 0) {
    const heavy = input.last7.filter((d) => d.activeMinutes > BURNOUT.overloadFactor * input.dailyGoalMinutes).length;
    const slope = accuracySlope(input.last7);
    if (heavy >= BURNOUT.overloadDays && slope !== null && slope < 0) candidates.push({ kind: 'overload_trend', action: 'rebalance' });
  }
  const pick = candidates.find((c) => c.kind === 'long_session' ? shown('long_session') < 2 : shown(c.kind) < BURNOUT.perKindPerDay);
  if (pick) out.push(pick);
  return out;
}

/** WEL-03.5 help card: always reachable from Perfil → Bem-estar. */
export const HELP_CARD = {
  cvvPhone: '188',
  cvvChatUrl: 'https://cvv.org.br',
  samuPhone: '192',
} as const;
