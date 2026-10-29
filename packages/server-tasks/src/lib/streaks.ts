// Streak rollover inputs (MOT-01, learning-engine §17.3): per study day activity into DailyActivity
// rows, then the shared evaluateStreak state machine. Pure; the job does the reads and writes.
import { autoRestDays, evaluateStreak, type DailyActivity, type StreakState } from '@studify/shared';
import { addDays } from './time.ts';

export interface DayFacts {
  activeMinutes: number;
  reviews: number;
  questions: number;
  sessions: number;
  xp: number;
}

/** Monday = 0 … Sunday = 6, matching study_preferences.minutes_by_weekday. */
export function weekdayMon0(day: string): number {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Study days from `from` through `to`, inclusive. Empty when from > to. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface ActivityContext {
  facts: ReadonlyMap<string, DayFacts>;
  examDays: ReadonlySet<string>;
  goals: ReadonlyArray<{ examDays: string[]; lastExamDay: string | null }>;
  restWeekday: number | null;
}

export function dailyActivityFor(days: readonly string[], ctx: ActivityContext): DailyActivity[] {
  const auto = autoRestDays(ctx.goals);
  return days.map((day) => {
    const f = ctx.facts.get(day) ?? { activeMinutes: 0, reviews: 0, questions: 0, sessions: 0, xp: 0 };
    return {
      day,
      activeMinutes: f.activeMinutes,
      cardReviews: f.reviews,
      completedSessions: f.sessions,
      examOfActiveGoal: ctx.examDays.has(day),
      restDay: ctx.restWeekday !== null && weekdayMon0(day) === ctx.restWeekday,
      autoRest: auto.has(day),
    };
  });
}

/** Advances the streak state over `days` (idempotent: days at or before lastEvaluated are skipped). */
export function rollStreak(state: StreakState, days: readonly DailyActivity[]): StreakState {
  return evaluateStreak(days, state);
}


