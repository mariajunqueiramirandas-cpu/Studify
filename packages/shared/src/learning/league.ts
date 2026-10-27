// Ligas semanais (SOC-08; learning-engine §17.5, spec 10 §8.5). The live board is computed in SQL
// (league_board); these functions mirror it for the weekly close job and the tests.
import type { LocalDate } from './types.ts';
import { compareStrings } from './util.ts';

export const LEAGUE = {
  dailyCap: 500,
  boardSize: 10,
  podium: 3,
  /** SOC-08.4 "Semana consistente": daily goal met on at least this many days. */
  consistentDays: 4,
} as const;

export interface LeagueXpEvent {
  localDate: LocalDate;
  amount: number;
  inQuietHours: boolean;
  /** ISO instant, for the "reached the total first" tie-break. */
  occurredAt: string;
}

/**
 * Weekly league XP: per day, the XP outside quiet hours capped at 500 (SOC-08.2/.5), summed over the week.
 * `reachedAt` is the last counted event, which breaks ties (earlier wins).
 */
export function leagueWeekXp(events: readonly LeagueXpEvent[]): { xp: number; reachedAt: string | null } {
  const perDay = new Map<LocalDate, number>();
  let reachedAt: string | null = null;
  for (const e of events) {
    if (e.inQuietHours || e.amount <= 0) continue;
    perDay.set(e.localDate, (perDay.get(e.localDate) ?? 0) + e.amount);
    if (reachedAt === null || e.occurredAt > reachedAt) reachedAt = e.occurredAt;
  }
  let xp = 0;
  for (const v of perDay.values()) xp += Math.min(LEAGUE.dailyCap, v);
  return { xp, reachedAt };
}

export interface LeagueEntryInput {
  userId: string;
  xp: number;
  reachedAt: string | null;
}

export interface RankedLeagueEntry extends LeagueEntryInput {
  rank: number;
}

/** Standard competition ranking by XP, then by who reached it first; full ties share a rank. */
export function rankLeague(entries: readonly LeagueEntryInput[]): RankedLeagueEntry[] {
  const sorted = [...entries].sort(
    (a, b) =>
      b.xp - a.xp ||
      (a.reachedAt ?? '￿').localeCompare(b.reachedAt ?? '￿') ||
      compareStrings(a.userId, b.userId),
  );
  const out: RankedLeagueEntry[] = [];
  sorted.forEach((e, i) => {
    const prev = out[i - 1];
    const tied = prev && prev.xp === e.xp && prev.reachedAt === e.reachedAt;
    out.push({ ...e, rank: tied ? prev.rank : i + 1 });
  });
  return out;
}

/** SOC-08.4 badges for a closed week: a podium badge for the top 3 (with XP), and "Semana consistente". */
export function leagueBadges(rank: number, xp: number, goalDaysMet: number): string[] {
  const badges: string[] = [];
  if (xp > 0 && rank <= LEAGUE.podium) badges.push(`podium_${rank}`);
  if (goalDaysMet >= LEAGUE.consistentDays) badges.push('consistent_week');
  return badges;
}

/** SOC-08.3: the top 10 and the viewer, never lower positions of others. */
export function visibleBoard<T extends { userId: string; rank: number }>(ranked: readonly T[], viewerId: string): T[] {
  return ranked.filter((r) => r.rank <= LEAGUE.boardSize || r.userId === viewerId);
}
