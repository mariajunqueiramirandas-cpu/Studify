// Motivation: XP, levels, streaks and active minutes (learning-engine §17; MOT-01, spec 13 §8.1–8.4).
import { MOTIVATION } from './params.ts';
import { addDays, DEFAULT_TIME_ZONE, studyDay } from './time.ts';
import type { LocalDate } from './types.ts';
import { compareStrings } from './util.ts';

// ---------- XP (§17.1) ----------

export type XpEvent =
  | { kind: 'card_reviewed'; sameCardWithinCooldown?: boolean }
  | { kind: 'question_answered'; firstAttemptToday: boolean; correct: boolean }
  | { kind: 'quiz_completed'; questionCount: number }
  | { kind: 'simulado_completed'; questionCount: number }
  | { kind: 'boss_defeated'; retry: boolean }
  | { kind: 'plan_item_completed' }
  | { kind: 'daily_goal_met' }
  | { kind: 'mistake_resolved' }
  | { kind: 'note_section_read' }
  | { kind: 'lucas_finished'; score: number }
  | { kind: 'argumentation_finished' }
  | { kind: 'podcast_completed' }
  | { kind: 'duel_finished'; won: boolean }
  | { kind: 'battle_played'; rank?: number | null }
  | { kind: 'error_report_accepted' }
  | { kind: 'focus_cycle_completed' };

/** Per-day counters the XP rules need for their caps (§17.1). */
export interface XpDayContext {
  dailyGoalXpAwarded: boolean;
  noteXpToday: number;
  podcastsToday: number;
}

/**
 * XP for one event (§17.1, spec 13 §8.1). Same XP for every FSRS rating, so a lying "Fácil" earns
 * nothing extra. Caps: notes ≤ 20 per day, podcasts ≤ 3 per day, daily goal once per day.
 * Question XP applies only to the first attempt of the day (assumption, see report).
 */
export function xpFor(event: XpEvent, today: XpDayContext): number {
  switch (event.kind) {
    case 'card_reviewed':
      return event.sameCardWithinCooldown ? 0 : 1;
    case 'question_answered':
      if (!event.firstAttemptToday) return 0;
      return 2 + (event.correct ? 1 : 0);
    case 'quiz_completed':
      return event.questionCount >= 5 ? 5 : 0;
    case 'simulado_completed':
      return 20 + Math.max(0, event.questionCount);
    case 'boss_defeated':
      return event.retry ? 10 : 50;
    case 'plan_item_completed':
      return 5;
    case 'daily_goal_met':
      return today.dailyGoalXpAwarded ? 0 : MOTIVATION.dailyGoalXp;
    case 'mistake_resolved':
      return 3;
    case 'note_section_read':
      return Math.max(0, Math.min(2, MOTIVATION.noteXpDailyCap - today.noteXpToday));
    case 'lucas_finished':
      return 10 + Math.floor(Math.max(0, event.score) / 10);
    case 'argumentation_finished':
      return 10;
    case 'podcast_completed':
      return today.podcastsToday >= MOTIVATION.podcastDailyCap ? 0 : 5;
    case 'duel_finished':
      return event.won ? 10 : 5;
    case 'battle_played': {
      const bonus = event.rank === 1 ? 10 : event.rank === 2 ? 6 : event.rank === 3 ? 3 : 0;
      return 5 + bonus;
    }
    case 'error_report_accepted':
      return 5;
    case 'focus_cycle_completed':
      return 3;
  }
}

// ---------- levels (§17.2) ----------

/** Total XP needed for level L: 50·L·(L+1). */
export function levelThreshold(level: number): number {
  return 50 * level * (level + 1);
}

/** Highest level whose threshold is at or below `totalXp`. 0 below 100 XP. */
export function levelFor(totalXp: number): number {
  let level = 0;
  while (levelThreshold(level + 1) <= totalXp) level += 1;
  return level;
}

// ---------- streaks (§17.3) ----------

export interface DailyActivity {
  /** Study day (04:00 boundary, §0.2). */
  day: LocalDate;
  activeMinutes: number;
  cardReviews: number;
  /** Completed quiz, duel, battle, Lucas or debate sessions. */
  completedSessions: number;
  /** An exam of an active goal falls on this day (counted automatically). */
  examOfActiveGoal: boolean;
  /** User-chosen rest day: neither a break nor an extension. */
  restDay: boolean;
  /** Auto rest day (see autoRestDays). */
  autoRest: boolean;
}

export interface StreakState {
  length: number;
  longest: number;
  shields: number;
  /** Consecutive counted days since the last lapse (drives the shield refill). */
  countedRun: number;
  lastEvaluated: LocalDate | null;
  shieldUsedOn: LocalDate[];
}

export function initialStreakState(): StreakState {
  return { length: 0, longest: 0, shields: 0, countedRun: 0, lastEvaluated: null, shieldUsedOn: [] };
}

/** counted(d): ≥ 5 active minutes, or ≥ 10 card reviews, or a completed session, or an exam of an active goal. */
export function isCountedDay(a: DailyActivity): boolean {
  return (
    a.activeMinutes >= MOTIVATION.countedMinutes ||
    a.cardReviews >= MOTIVATION.countedReviews ||
    a.completedSessions >= 1 ||
    a.examOfActiveGoal
  );
}

/**
 * Auto rest days: exam dates of active goals, and the day after each goal's last exam (§17.3).
 * `goals` lists, per active goal, its exam days and its last exam day.
 */
export function autoRestDays(goals: ReadonlyArray<{ examDays: readonly LocalDate[]; lastExamDay: LocalDate | null }>): Set<LocalDate> {
  const out = new Set<LocalDate>();
  for (const goal of goals) {
    for (const d of goal.examDays) out.add(d);
    if (goal.lastExamDay) out.add(addDays(goal.lastExamDay, 1));
  }
  return out;
}

/**
 * evaluateStreak (§17.3). Processes every day after `state.lastEvaluated` up to the last day given.
 * Days missing from `days` count as empty days. Evaluation is idempotent for already-processed days.
 *   counted → length += 1; every 7 counted days in a row, shields = min(2, shields + 1)
 *   rest or auto-rest → nothing (neither break nor extension; the run continues)
 *   otherwise → spend a shield (the length is kept), or reset length and the run to 0
 */
export function evaluateStreak(days: readonly DailyActivity[], state: StreakState): StreakState {
  if (days.length === 0) return state;
  const byDay = new Map<LocalDate, DailyActivity>();
  for (const d of days) byDay.set(d.day, d);
  const sortedDays = [...byDay.keys()].sort(compareStrings);
  const last = sortedDays[sortedDays.length - 1];
  if (!last) return state;

  let cursor = state.lastEvaluated ? addDays(state.lastEvaluated, 1) : (sortedDays[0] ?? last);
  let next: StreakState = { ...state, shieldUsedOn: [...state.shieldUsedOn] };
  while (cursor <= last) {
    next = stepDay(next, byDay.get(cursor) ?? emptyDay(cursor));
    cursor = addDays(cursor, 1);
  }
  return next;
}

function emptyDay(day: LocalDate): DailyActivity {
  return {
    day,
    activeMinutes: 0,
    cardReviews: 0,
    completedSessions: 0,
    examOfActiveGoal: false,
    restDay: false,
    autoRest: false,
  };
}

function stepDay(state: StreakState, a: DailyActivity): StreakState {
  const base: StreakState = { ...state, lastEvaluated: a.day };
  if (isCountedDay(a)) {
    const countedRun = state.countedRun + 1;
    let shields = state.shields;
    if (countedRun % MOTIVATION.shieldEveryCountedDays === 0) {
      shields = Math.min(MOTIVATION.shieldsMax, shields + 1);
    }
    const length = state.length + 1;
    return { ...base, length, longest: Math.max(state.longest, length), countedRun, shields };
  }
  if (a.restDay || a.autoRest) return base;
  if (state.shields > 0) {
    return { ...base, shields: state.shields - 1, shieldUsedOn: [...state.shieldUsedOn, a.day] };
  }
  return { ...base, length: 0, countedRun: 0 };
}

/**
 * Active minutes from interaction timestamps (§17.4, spec 13 §8.2). A minute is active when the user
 * interacted in it, and minutes between two interactions less than 90 s apart are active too. Each
 * active minute is attributed to the study day of its start. Returns minutes per study day.
 */
export function activeMinutesByStudyDay(
  timestampsMs: readonly number[],
  timeZone: string = DEFAULT_TIME_ZONE,
  idleGapMs: number = MOTIVATION.activeIdleGapMs,
): Record<LocalDate, number> {
  const minute = 60_000;
  const sorted = [...new Set(timestampsMs)].sort((a, b) => a - b);
  const marked = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i] ?? 0;
    marked.add(Math.floor(t / minute) * minute);
    const nextT = sorted[i + 1];
    if (nextT !== undefined && nextT - t <= idleGapMs) {
      for (let m = Math.floor(t / minute) * minute; m <= nextT; m += minute) marked.add(m);
    }
  }
  const out: Record<LocalDate, number> = {};
  for (const m of marked) {
    const day = studyDay(new Date(m), timeZone);
    out[day] = (out[day] ?? 0) + 1;
  }
  return out;
}
