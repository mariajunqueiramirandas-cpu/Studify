// WEL-03.4 weekly check-in "Como você tá com os estudos?". Stored on the phone only (wellbeing_checkins).
import { asc, eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { wellbeingCheckins } from '../../db/schema';
import { localDateOf } from '../../lib/dates';

export const CHECKIN_FACES = ['😣', '😕', '😐', '🙂', '😄'] as const;

/** Monday of the week containing `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7), 12);
  return localDateOf(monday);
}

export function saveCheckin(db: AppDb, mood: number, now = new Date()): void {
  const week = weekStartOf(now);
  const answers = { mood: Math.min(5, Math.max(1, Math.round(mood))), at: now.toISOString() };
  db.insert(wellbeingCheckins).values({ weekStart: week, answers }).onConflictDoUpdate({ target: wellbeingCheckins.weekStart, set: { answers } }).run();
}

/** Answers oldest first (1 = lowest … 5). */
export function checkinMoods(db: AppDb): number[] {
  return db
    .select()
    .from(wellbeingCheckins)
    .orderBy(asc(wellbeingCheckins.weekStart))
    .all()
    .map((r) => Number((r.answers as { mood?: number }).mood))
    .filter((n) => n >= 1 && n <= 5);
}

export function answeredThisWeek(db: AppDb, now = new Date()): boolean {
  return !!db.select().from(wellbeingCheckins).where(eq(wellbeingCheckins.weekStart, weekStartOf(now))).get();
}
