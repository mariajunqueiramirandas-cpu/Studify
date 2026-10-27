// Local-time helpers for quiet hours (PLT-05.3) and the study-day boundary (day_rollover_hour).
// Pure functions over Intl; no clock access, so tests pass explicit instants.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

export function localParts(instant: Date, timeZone: string): LocalParts & { second: number } {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of UTC). */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

/** The instant at which the wall clock in `timeZone` reads y-m-d hh:mm. */
export function zonedToInstant(y: number, mo: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const first = guess - tzOffsetMs(new Date(guess), timeZone);
  const second = guess - tzOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** "HH:MM" or "HH:MM:SS" to minutes after midnight. */
export function minutesOfDay(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m ?? 0);
}

/**
 * If `now` falls inside the quiet window [start, end) in `timeZone`, returns the instant the window
 * ends. Otherwise returns null. The window may cross midnight (22:00 to 07:00).
 */
export function quietWindowEnd(now: Date, timeZone: string, quietStart: string, quietEnd: string): Date | null {
  const start = minutesOfDay(quietStart);
  const end = minutesOfDay(quietEnd);
  if (start === end) return null;
  const p = localParts(now, timeZone);
  const m = p.hour * 60 + p.minute;
  const inside = start < end ? m >= start && m < end : m >= start || m < end;
  if (!inside) return null;
  const crossesMidnight = start > end && m >= start;
  const endDate = crossesMidnight ? addDays(p.year, p.month, p.day, 1) : { y: p.year, m: p.month, d: p.day };
  return zonedToInstant(endDate.y, endDate.m, endDate.d, Math.floor(end / 60), end % 60, timeZone);
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Instant at which the current study day started (day boundary at `rolloverHour` local). */
export function studyDayStart(now: Date, timeZone: string, rolloverHour: number): Date {
  const shifted = new Date(now.getTime() - rolloverHour * 3_600_000);
  const p = localParts(shifted, timeZone);
  return zonedToInstant(p.year, p.month, p.day, rolloverHour, 0, timeZone);
}

/** Next local midnight after `now`, plus `minutesAfter` minutes (budget resets, PLT-04). */
export function nextLocalMidnight(now: Date, timeZone: string, minutesAfter = 5): Date {
  const p = localParts(now, timeZone);
  const next = addDays(p.year, p.month, p.day, 1);
  return new Date(zonedToInstant(next.y, next.m, next.d, 0, minutesAfter, timeZone).getTime());
}
