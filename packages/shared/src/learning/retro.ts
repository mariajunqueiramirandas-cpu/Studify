// Retrospectiva (MOT-04, spec 13 §5–7). Which periods are due, and the 6–8 story cards built from the stats.
// Stats never carry classmates' names; grades appear only when the student turns on "Mostrar notas" (MOT-04.3).
import { addDays } from './time.ts';
import type { LocalDate } from './types.ts';

export type RetroPeriodType = 'goal' | 'semester' | 'year';

/** Default semester ends (MOT-04.1): end of June and end of November, as MM-DD. */
export const DEFAULT_SEMESTER_ENDS = ['06-30', '11-30'] as const;
/** The yearly Retrospectiva comes on this December day and covers the year up to the day before. */
export const YEAR_RETRO_DAY = '12-20';

export interface RetroPeriod {
  type: RetroPeriodType;
  goalId: string | null;
  start: LocalDate;
  end: LocalDate;
}

export interface RetroGoalInput {
  id: string;
  startDate: LocalDate;
  /** Date of the goal's last exam; null while the goal has none. */
  lastExamDay: LocalDate | null;
}

function monthDayValid(md: string): boolean {
  return /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(md);
}

/**
 * Periods whose Retrospectiva is due on `today` (MOT-04.1):
 *  - goal: the day after the goal's last exam, covering the goal from its start;
 *  - semester: the day after each semester end, covering from the day after the previous end;
 *  - year: on December 20, covering January 1 to December 19.
 */
export function retroPeriodsDue(today: LocalDate, goals: readonly RetroGoalInput[], semesterEnds: readonly string[] = DEFAULT_SEMESTER_ENDS): RetroPeriod[] {
  const out: RetroPeriod[] = [];
  const yesterday = addDays(today, -1);
  for (const g of goals) {
    if (g.lastExamDay && g.lastExamDay === yesterday) out.push({ type: 'goal', goalId: g.id, start: g.startDate, end: g.lastExamDay });
  }
  const year = Number(today.slice(0, 4));
  const ends = [...new Set(semesterEnds.filter(monthDayValid))].sort();
  for (const [i, md] of ends.entries()) {
    if (`${year}-${md}` !== yesterday && `${year - 1}-${md}` !== yesterday) continue;
    const endYear = yesterday.slice(0, 4);
    const prev = i > 0 ? `${endYear}-${ends[i - 1]}` : `${Number(endYear) - 1}-${ends[ends.length - 1]}`;
    out.push({ type: 'semester', goalId: null, start: addDays(prev, 1), end: yesterday });
  }
  if (today.slice(5) === YEAR_RETRO_DAY) out.push({ type: 'year', goalId: null, start: `${year}-01-01`, end: yesterday });
  return out;
}

export interface RetroStats {
  period: RetroPeriodType;
  active_minutes: number;
  days_studied: number;
  cards_reviewed: number;
  questions_answered: number;
  accuracy: number | null;
  best_subject: { name: string; accuracy: number } | null;
  most_improved_topic: { title: string; from: number; to: number } | null;
  longest_streak: number;
  best_lucas_score: number | null;
  duels_won: number;
  /** Calibration gap change (PRA-05): positive = better calibrated than at the start. */
  calibration_gain: number | null;
  /** Logged grades of the period; shown only with "Mostrar notas". */
  grades: Array<{ subject: string; grade: string }>;
}

export type RetroCard =
  | { kind: 'intro'; title: string; subtitle: string | null }
  | { kind: 'hours'; hours: number; days: number }
  | { kind: 'cards'; count: number }
  | { kind: 'questions'; count: number; accuracy: number | null }
  | { kind: 'best_subject'; name: string; accuracy: number }
  | { kind: 'most_improved'; title: string; from: number; to: number }
  | { kind: 'streak'; days: number }
  | { kind: 'lucas'; score: number }
  | { kind: 'duels'; won: number }
  | { kind: 'calibration'; gain: number }
  | { kind: 'grades'; grades: Array<{ subject: string; grade: string }> }
  | { kind: 'closing' };

/**
 * The story (MOT-04.2): intro, then the stats that have something to show in a fixed order, then the closing card.
 * At most 8 cards; at least 6 by keeping the always-present ones (hours, cards, questions, streak).
 */
export function retroCards(stats: RetroStats, title: string, subtitle: string | null, opts: { showGrades: boolean }): RetroCard[] {
  const middle: RetroCard[] = [{ kind: 'hours', hours: Math.round((stats.active_minutes / 60) * 10) / 10, days: stats.days_studied }];
  const optional: RetroCard[] = [];
  middle.push({ kind: 'cards', count: stats.cards_reviewed });
  middle.push({ kind: 'questions', count: stats.questions_answered, accuracy: stats.accuracy });
  if (stats.best_subject) optional.push({ kind: 'best_subject', ...stats.best_subject });
  if (stats.most_improved_topic && stats.most_improved_topic.to > stats.most_improved_topic.from) optional.push({ kind: 'most_improved', ...stats.most_improved_topic });
  if (stats.best_lucas_score !== null) optional.push({ kind: 'lucas', score: stats.best_lucas_score });
  if (stats.duels_won > 0) optional.push({ kind: 'duels', won: stats.duels_won });
  if (stats.calibration_gain !== null && stats.calibration_gain > 0) optional.push({ kind: 'calibration', gain: stats.calibration_gain });
  // The student asked for grades: they come first among the optional cards.
  if (opts.showGrades && stats.grades.length) optional.unshift({ kind: 'grades', grades: stats.grades });
  const streak: RetroCard = { kind: 'streak', days: stats.longest_streak };
  // intro + closing + 4 fixed = 6; room for 2 optional cards.
  return [{ kind: 'intro', title, subtitle }, ...middle, ...optional.slice(0, 2), streak, { kind: 'closing' }];
}

/** MOT-04.4 fallback when the AI title fails or is unavailable. */
export function retroFallbackTitle(type: RetroPeriodType): { title: string; subtitle: string } {
  switch (type) {
    case 'goal':
      return { title: 'Que semana de provas, hein! ✨', subtitle: 'Olha tudo o que você estudou.' };
    case 'semester':
      return { title: 'Que semestre, hein! ✨', subtitle: 'Seu semestre em números.' };
    case 'year':
      return { title: 'Que ano, hein! ✨', subtitle: 'Seu ano de estudos em números.' };
  }
}
