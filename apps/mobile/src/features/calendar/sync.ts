// Calendar sync (GOL-09, spec 07 §8.8). Opt-in, Android device calendar through expo-calendar:
//  - read: busy time in the calendars the student picked turns into free minutes per date; only that number
//    leaves the phone (GOL-09.2), through set_calendar_availability;
//  - write: a local "Studify" calendar gets the tests and the planned study blocks, placed in the best energy
//    windows (GOL-10.2). Studify only touches events in its own calendar (GOL-09.3);
//  - off: the Studify calendar is removed from the phone and the calendar rows are cleared (GOL-09.4).
import { ENERGY, freeIntervals, freeMinutes, placeBlocks, type BlockUnit, type MinuteInterval } from '@studify/shared';
import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import { supabase } from '../../api/supabase';
import type { AppDb } from '../../db/client';
import { calendarEvents, exams, planItems, studyPreferences } from '../../db/schema';
import { localDateOf } from '../../lib/dates';
import { getKv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { recomputePlan } from '../goals/api';

const KV = {
  enabled: 'calendar.enabled',
  busy: 'calendar.busyIds',
  calendarId: 'calendar.studifyId',
  lastSync: 'calendar.lastSync',
  lastDays: 'calendar.lastDays',
} as const;

/** Days ahead the sync covers. */
export const CALENDAR_DAYS = 14;
const STUDIFY_TITLE = 'Studify';
const STUDIFY_COLOR = '#4F46E5';
/** Keys of the device-only calendar_events table: plan items by id, tests as "exam:<id>". */
const examKey = (id: string) => `exam:${id}`;

export interface CalendarSettings {
  enabled: boolean;
  busyIds: string[];
  calendarId: string | null;
  lastSync: number | null;
}

export function calendarSettings(): CalendarSettings {
  const kv = getKv();
  let busyIds: string[] = [];
  try {
    busyIds = JSON.parse(kv.getString(KV.busy) ?? '[]') as string[];
  } catch {
    busyIds = [];
  }
  return { enabled: kv.getBoolean(KV.enabled) ?? false, busyIds, calendarId: kv.getString(KV.calendarId) ?? null, lastSync: kv.getNumber(KV.lastSync) ?? null };
}

export function setBusyCalendars(ids: string[]): void {
  getKv().set(KV.busy, JSON.stringify([...new Set(ids)]));
}

export interface DeviceCalendar {
  id: string;
  title: string;
  color: string | null;
  account: string | null;
}

/** Calendars the student can mark as busy (Studify's own is left out). */
export async function listDeviceCalendars(): Promise<DeviceCalendar[]> {
  const own = calendarSettings().calendarId;
  const list = await Calendar.getCalendars();
  return list
    .filter((c) => c.id !== own && c.isVisible !== false)
    .map((c) => ({ id: c.id, title: c.title, color: c.color ?? null, account: c.ownerAccount ?? c.source?.name ?? null }));
}

async function ensureStudifyCalendar(): Promise<string> {
  const known = calendarSettings().calendarId;
  if (known) {
    const all = await Calendar.getCalendars();
    if (all.some((c) => c.id === known)) return known;
  }
  const created = await Calendar.createCalendar({
    title: STUDIFY_TITLE,
    name: 'studify',
    color: STUDIFY_COLOR,
    ownerAccount: 'studify',
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
    source: { isLocalAccount: true, name: STUDIFY_TITLE, type: 'LOCAL' },
  });
  getKv().set(KV.calendarId, created.id);
  return created.id;
}

/** Turns sync on: asks for the calendar permission (in context) and creates the Studify calendar. */
export async function enableCalendarSync(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const perm = await Calendar.requestCalendarPermissions();
  if (perm.status !== 'granted') return false;
  await ensureStudifyCalendar();
  getKv().set(KV.enabled, true);
  return true;
}

/** GOL-09.4: removes the Studify calendar and its events, and clears the calendar availability rows. */
export async function disableCalendarSync(db: AppDb): Promise<void> {
  const { calendarId } = calendarSettings();
  if (calendarId) {
    try {
      const cal = await Calendar.ExpoCalendar.get(calendarId);
      await cal.delete();
    } catch (e) {
      logger.warn('calendar.delete_failed', { error: String(e) });
    }
  }
  db.delete(calendarEvents).run();
  const today = localDateOf(Date.now());
  const days = Array.from({ length: CALENDAR_DAYS + 1 }, (_, i) => ({ local_date: addLocalDays(today, i), minutes: null }));
  await supabase.rpc('set_calendar_availability', { p_days: days }).then(
    () => undefined,
    () => undefined,
  );
  const kv = getKv();
  kv.set(KV.enabled, false);
  kv.remove(KV.calendarId);
  kv.remove(KV.lastSync);
  kv.remove(KV.lastDays);
  await recomputePlan('availability_changed').catch(() => undefined);
}

function addLocalDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDateOf(new Date(y!, m! - 1, d! + n, 12));
}

const hhmm = (t: string | null | undefined, fallback: string) => (t ?? fallback).slice(0, 5);
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Busy intervals per local date (all-day and "free" events never count as busy). */
export function busyByDate(events: readonly { start: Date; end: Date; allDay: boolean; free: boolean }[], dates: readonly string[]): Map<string, MinuteInterval[]> {
  const out = new Map<string, MinuteInterval[]>(dates.map((d) => [d, []]));
  for (const e of events) {
    if (e.allDay || e.free || e.end <= e.start) continue;
    for (const date of dates) {
      const [y, m, d] = date.split('-').map(Number);
      const dayStart = new Date(y!, m! - 1, d!, 0, 0).getTime();
      const dayEnd = new Date(y!, m! - 1, d! + 1, 0, 0).getTime();
      const s = Math.max(e.start.getTime(), dayStart);
      const en = Math.min(e.end.getTime(), dayEnd);
      if (en <= s) continue;
      out.get(date)!.push({ start: Math.round((s - dayStart) / 60_000), end: Math.round((en - dayStart) / 60_000) });
    }
  }
  return out;
}

function at(date: string, minute: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, Math.floor(minute / 60), minute % 60);
}

export interface CalendarSyncResult {
  days: number;
  placed: number;
  unplaced: number;
}

/**
 * One sync pass over the next 14 days: reduce availability from busy time, then (re)write the Studify events.
 * `goodBuckets` are the student's best energy windows (performance_windows).
 */
export async function runCalendarSync(db: AppDb, userId: string, goodBuckets: readonly number[]): Promise<CalendarSyncResult | null> {
  const settings = calendarSettings();
  if (!settings.enabled || Platform.OS !== 'android') return null;
  const perm = await Calendar.getCalendarPermissions();
  if (perm.status !== 'granted') return null;
  const calendarId = await ensureStudifyCalendar();

  const prefs = db.select().from(studyPreferences).where(eq(studyPreferences.userId, userId)).get();
  const window = { start: hhmm(prefs?.windowStart, '14:00'), end: hhmm(prefs?.windowEnd, '21:30') };
  const quiet = { start: hhmm(prefs?.quietStart, '22:00'), end: hhmm(prefs?.quietEnd, '07:00') };
  const today = localDateOf(Date.now());
  const dates = Array.from({ length: CALENDAR_DAYS }, (_, i) => addLocalDays(today, i));
  const from = at(dates[0]!, 0);
  const to = at(addLocalDays(today, CALENDAR_DAYS), 0);

  // ---- read: busy calendars → free minutes per date (titles stay here) ----
  const busyEvents = settings.busyIds.length ? await Calendar.listEvents(settings.busyIds, from, to) : [];
  const busy = busyByDate(
    busyEvents.map((e) => ({
      start: new Date(e.startDate),
      end: new Date(e.endDate),
      allDay: !!e.allDay,
      free: e.availability === Calendar.Availability.FREE,
    })),
    dates,
  );
  const base = prefs?.minutesByWeekday ?? [60, 60, 60, 60, 60, 90, 30];
  const days = dates.map((d) => {
    const free = freeMinutes(window, busy.get(d) ?? [], quiet);
    const [y, m, dd] = d.split('-').map(Number);
    const weekdayMon0 = (new Date(y!, m! - 1, dd!).getDay() + 6) % 7;
    const planned = base[weekdayMon0] ?? 0;
    // Only days where busy time leaves less than the usual study minutes carry a calendar row (GOL-09.2).
    return { local_date: d, minutes: (busy.get(d) ?? []).length && free < planned ? free : null };
  });
  const { error } = await supabase.rpc('set_calendar_availability', { p_days: days });
  if (error) logger.warn('calendar.availability_failed', { code: error.code });
  // Availability changed: the planner moves work to the free days (GOL-04 replan).
  const signature = JSON.stringify(days.filter((d) => d.minutes !== null));
  if (!error && signature !== getKv().getString(KV.lastDays)) {
    getKv().set(KV.lastDays, signature);
    await recomputePlan('availability_changed').catch(() => undefined);
  }

  // ---- write: tests and planned blocks into the Studify calendar ----
  const items = db
    .select()
    .from(planItems)
    .where(and(eq(planItems.userId, userId), gte(planItems.localDate, dates[0]!), lte(planItems.localDate, dates[dates.length - 1]!), isNull(planItems.deletedAt)))
    .all()
    .filter((i) => i.status === 'planned');
  const tests = db
    .select()
    .from(exams)
    .where(and(eq(exams.userId, userId), gte(exams.localDate, dates[0]!), lte(exams.localDate, dates[dates.length - 1]!), isNull(exams.deletedAt)))
    .all()
    .filter((e) => e.status !== 'cancelled');

  type Wanted = { key: string; title: string; start: Date; end: Date; allDay: boolean; notes: string };
  const wanted: Wanted[] = [];
  let placedCount = 0;
  let unplacedCount = 0;
  for (const d of dates) {
    const units: BlockUnit[] = items.filter((i) => i.localDate === d).map((i) => ({ id: i.id, minutes: i.minutes, demanding: !!i.demanding }));
    if (units.length) {
      const { placed, unplaced } = placeBlocks(units, freeIntervals(window, busy.get(d) ?? [], quiet), goodBuckets);
      placedCount += placed.length;
      unplacedCount += unplaced.length;
      for (const p of placed) {
        wanted.push({ key: p.id, title: 'Estudar (Studify)', start: at(d, toMin(p.start)), end: at(d, toMin(p.end)), allDay: false, notes: 'Bloco do seu plano de estudos.' });
      }
    }
    for (const e of tests.filter((x) => x.localDate === d)) {
      const start = e.startsAt ? new Date(e.startsAt) : at(d, 0);
      const end = e.startsAt ? new Date(start.getTime() + (e.durationMin ?? 60) * 60_000) : at(addLocalDays(d, 1), 0);
      wanted.push({ key: examKey(e.id), title: `Prova: ${e.title}`, start, end, allDay: !e.startsAt, notes: 'Prova cadastrada no Studify.' });
    }
  }

  const cal = await Calendar.ExpoCalendar.get(calendarId);
  const known = new Map(db.select().from(calendarEvents).all().map((r) => [r.planItemId, r]));
  const keep = new Set(wanted.map((w) => w.key));
  for (const w of wanted) {
    const row = known.get(w.key);
    const details = { title: w.title, startDate: w.start, endDate: w.end, allDay: w.allDay, notes: w.notes, availability: Calendar.Availability.BUSY };
    try {
      if (row && row.calendarId === calendarId) {
        const ev = await Calendar.ExpoCalendarEvent.get(row.eventId);
        await ev.update(details);
      } else {
        const ev = await cal.createEvent(details);
        db.insert(calendarEvents).values({ planItemId: w.key, calendarId, eventId: ev.id }).onConflictDoUpdate({ target: calendarEvents.planItemId, set: { calendarId, eventId: ev.id } }).run();
      }
    } catch {
      // The event was deleted by hand: create it again next pass.
      db.delete(calendarEvents).where(eq(calendarEvents.planItemId, w.key)).run();
    }
  }
  // Replans: events for blocks that are gone, done or skipped are removed.
  for (const [key, row] of known) {
    if (keep.has(key)) continue;
    try {
      const ev = await Calendar.ExpoCalendarEvent.get(row.eventId);
      await ev.delete();
    } catch {
      // already gone
    }
    db.delete(calendarEvents).where(eq(calendarEvents.planItemId, key)).run();
  }
  getKv().set(KV.lastSync, Date.now());
  return { days: days.filter((d) => d.minutes !== null).length, placed: placedCount, unplaced: unplacedCount };
}

/** Same shape as the server's energy buckets, for labels. */
export const BUCKET_HOURS = ENERGY.bucketMinutes / 60;
