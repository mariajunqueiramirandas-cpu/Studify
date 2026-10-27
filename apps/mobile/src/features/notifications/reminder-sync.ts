// Keeps the rich local reminders scheduled (mobile-app.md §5.2: re-planned on app start, after syncs and when
// the app comes back). Reads SQLite for the snapshot, plans with planRichReminders and hands the result to
// the native scheduler, which re-arms them after a reboot.
import { parseProfileSettings, suggestedReminderTimes } from '@studify/shared';
import { and, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { examScopeNodes, exams, studyPreferences, subjects } from '../../db/schema';
import { localDateOf, studyDateOf } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { richNotifier } from '../../platform/rich-notify';
import { buildLocalQueue } from '../memory/local';
import { readPlanItems } from '../goals/today';
import { planRichReminders, type ReminderSnapshot } from './reminders';

export const REMINDER_PREFIX = 'rem:';

export interface ReminderExtras {
  settings: unknown;
  bestBuckets: readonly number[];
  streak: ReminderSnapshot['streak'];
}

const hm = (v: string | null | undefined, d: string) => (v ?? d).slice(0, 5);

function at(now: Date, dayOffset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h ?? 0, m ?? 0);
}

export function collectReminderSnapshot(db: AppDb, userId: string, extras: ReminderExtras, now = new Date()): ReminderSnapshot {
  let settings = parseProfileSettings({});
  try {
    settings = parseProfileSettings(extras.settings);
  } catch {
    // keep defaults
  }
  const prefs = db.select().from(studyPreferences).where(eq(studyPreferences.userId, userId)).get();
  const windowStart = hm(prefs?.windowStart, '14:00');
  const quiet = { start: hm(prefs?.quietStart, '22:00'), end: hm(prefs?.quietEnd, '07:00') };
  const best = extras.bestBuckets.length ? suggestedReminderTimes(extras.bestBuckets, { start: windowStart, end: hm(prefs?.windowEnd, '21:30') }, quiet) : [];
  const reviewTimes = best.length ? best : [windowStart];

  const dueByDay = [0, 1, 2].map((d) => {
    const when = reviewTimes.map((t) => at(now, d, t)).find((x) => x > now) ?? at(now, d, reviewTimes[0]!);
    try {
      return buildLocalQueue(db, { now: when, limit: 1000 }).length;
    } catch {
      return 0;
    }
  });
  let nextCard: ReminderSnapshot['nextCard'] = null;
  try {
    const first = buildLocalQueue(db, { now, limit: 1 })[0];
    if (first && first.type !== 'occlusion') {
      const s = db.select({ name: subjects.name, color: subjects.color }).from(subjects).where(eq(subjects.id, first.subjectId)).get();
      nextCard = { id: first.id, front: first.front, back: first.back, type: first.type, clozeIndex: first.clozeIndex, subject: s?.name ?? null, color: s?.color ?? null };
    }
  } catch {
    nextCard = null;
  }

  const today = studyDateOf(now);
  const tomorrow = studyDateOf(new Date(now.getTime() + 86_400_000));
  const plans = [today, tomorrow].map((day) =>
    readPlanItems(db, day)
      .filter((i) => i.status === 'planned')
      .map((i) => ({ title: i.title, minutes: i.minutes })),
  );

  const horizon = localDateOf(new Date(now.getTime() + 3 * 86_400_000));
  const soon = db
    .select()
    .from(exams)
    .where(and(isNull(exams.deletedAt), gte(exams.localDate, localDateOf(now)), lte(exams.localDate, horizon)))
    .all()
    .filter((e) => e.status !== 'cancelled' && e.status !== 'done');
  const subjectRows = soon.length
    ? db
        .select({ id: subjects.id, name: subjects.name, color: subjects.color })
        .from(subjects)
        .where(inArray(subjects.id, soon.map((e) => e.subjectId).filter((x): x is string => !!x)))
        .all()
    : [];
  const subjectById = new Map(subjectRows.map((s) => [s.id, s]));
  const topicCount = (examId: string) => db.select({ n: examScopeNodes.nodeId }).from(examScopeNodes).where(eq(examScopeNodes.examId, examId)).all().length;
  const examsSoon = soon.map((e) => {
    const s = e.subjectId ? subjectById.get(e.subjectId) : undefined;
    return { id: e.id, goalId: e.goalId, title: e.title, subject: s?.name ?? null, color: s?.color ?? null, localDate: e.localDate, startsAt: e.startsAt ?? null, topics: topicCount(e.id) };
  });

  const weekAgo = localDateOf(new Date(now.getTime() - 7 * 86_400_000));
  const ungraded = db
    .select()
    .from(exams)
    .where(and(isNull(exams.deletedAt), gte(exams.localDate, weekAgo), lt(exams.localDate, localDateOf(now))))
    .all()
    .filter((e) => e.grade === null && e.status !== 'cancelled')
    .map((e) => ({ id: e.id, goalId: e.goalId, title: e.title }));

  const notifications = (settings.notifications ?? {}) as Partial<Record<'reviews' | 'plan', boolean>>;
  return {
    now,
    enabled: settings.reminders_enabled !== false,
    channels: { reviews: notifications.reviews !== false, plan: notifications.plan !== false },
    quiet,
    windowStart,
    vesperaTime: hm(prefs?.vesperaTime, '19:00'),
    reviewTimes,
    dueByDay,
    nextCard,
    plans,
    exams: examsSoon,
    ungraded,
    streak: extras.streak,
  };
}

/** Replaces every scheduled reminder with a fresh plan. Returns how many were scheduled. */
export async function syncReminders(db: AppDb, userId: string, extras: ReminderExtras, now = new Date()): Promise<number> {
  try {
    const plan = planRichReminders(collectReminderSnapshot(db, userId, extras, now));
    await richNotifier.cancelScheduled(REMINDER_PREFIX);
    let n = 0;
    for (const r of plan.scheduled) if (await richNotifier.schedule(REMINDER_PREFIX + r.id, r.at, r.rich)) n++;
    return n;
  } catch (e) {
    logger.warn('reminders.sync_failed', { error: String(e) });
    return 0;
  }
}
