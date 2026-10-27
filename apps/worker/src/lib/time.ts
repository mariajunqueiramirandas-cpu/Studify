// Local-time helpers for the worker. The study-day rule comes from @studify/shared (studyDayOf);
// this file only adds quiet-hour arithmetic and a safe time-zone fallback (profiles.timezone).
import {
  DEFAULT_TIME_ZONE,
  addDays,
  isValidTimeZone,
  localDateOf,
  studyDayOf,
  wallClockOf,
  wallTimeToInstant,
  type LocalDate,
} from '@studify/shared';

export { addDays, DEFAULT_TIME_ZONE, localDateOf, studyDayOf, wallTimeToInstant };
export type { LocalDate };

export const DEFAULT_ROLLOVER_HOUR = 4;

export function safeTimeZone(value: string | null | undefined): string {
  return value && isValidTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

/** 'HH:MM' or 'HH:MM:SS' (Postgres time text) → minutes from midnight. */
export function minutesOf(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minutes from local midnight of `at` in `timeZone`. */
export function localMinutes(at: Date, timeZone: string): number {
  const w = wallClockOf(at, timeZone);
  return w.hour * 60 + w.minute;
}

/** True when `at` falls inside the quiet window (PLT-05.3). The window may wrap past midnight. */
export function inQuietHours(at: Date, timeZone: string, quietStart: string, quietEnd: string): boolean {
  const m = localMinutes(at, timeZone);
  const s = minutesOf(quietStart);
  const e = minutesOf(quietEnd);
  if (s === e) return false;
  return s > e ? m >= s || m < e : m >= s && m < e;
}


export function localHour(at: Date, timeZone: string): number {
  return wallClockOf(at, timeZone).hour;
}

export function studyDayFor(at: Date, timeZone: string, rolloverHour = DEFAULT_ROLLOVER_HOUR): LocalDate {
  return studyDayOf(at, timeZone, rolloverHour);
}

