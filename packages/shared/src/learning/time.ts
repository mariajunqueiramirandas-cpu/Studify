// Study-day helpers (learning-engine §0.2, MEM-02.13). Private to the learning engine:
// the core package owns the canonical copy, and this one must not drift from it.
import type { LocalDate } from './types.ts';

/** Study day starts at 04:00 local time (MEM-02.13). Activity at 01:30 belongs to the previous day. */
export const DAY_ROLLOVER_HOUR = 4;
/** Default time zone (§0.2). Brazil dropped DST in 2019, so the fixed offset is a safe fallback. */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

const FIXED_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  'America/Sao_Paulo': -180,
  UTC: 0,
  'Etc/UTC': 0,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(tz, fmt);
  return fmt;
}

/** Offset of `tz` from UTC at instant `at`, in milliseconds (local = UTC + offset). */
export function tzOffsetMs(tz: string, at: Date): number {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = formatterFor(tz);
  } catch {
    const fixed = FIXED_OFFSET_MINUTES[tz];
    if (fixed === undefined) throw new RangeError(`Unknown time zone: ${tz}`);
    return fixed * 60_000;
  }
  const parts = fmt.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value ?? '0';
    const n = Number(value);
    return type === 'hour' && n === 24 ? 0 : n;
  };
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  const wholeSecond = Math.floor(at.getTime() / 1000) * 1000;
  return asUtc - wholeSecond;
}

function parseDay(day: LocalDate): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Study day (LocalDate) that contains instant `at` in time zone `tz`. */
export function studyDay(at: Date, tz: string = DEFAULT_TIME_ZONE): LocalDate {
  const shifted = new Date(at.getTime() + tzOffsetMs(tz, at) - DAY_ROLLOVER_HOUR * 3_600_000);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Instant of a local wall-clock time on a calendar date in `tz`. */
export function wallClock(day: LocalDate, hour: number, minute: number, tz: string = DEFAULT_TIME_ZONE): Date {
  const [y, m, d] = parseDay(day);
  const wallMs = Date.UTC(y, m - 1, d, hour, minute);
  const first = wallMs - tzOffsetMs(tz, new Date(wallMs));
  return new Date(wallMs - tzOffsetMs(tz, new Date(first)));
}

/** Instant at which study day `day` starts (its 04:00 rollover). */
export function startOfStudyDay(day: LocalDate, tz: string = DEFAULT_TIME_ZONE): Date {
  return wallClock(day, DAY_ROLLOVER_HOUR, 0, tz);
}

/** Last millisecond of study day `day`. */
export function endOfStudyDay(day: LocalDate, tz: string = DEFAULT_TIME_ZONE): Date {
  return new Date(startOfStudyDay(addDays(day, 1), tz).getTime() - 1);
}

/** Calendar arithmetic on LocalDate strings (no time zone involved). */
export function addDays(day: LocalDate, n: number): LocalDate {
  const [y, m, d] = parseDay(day);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = parseDay(from);
  const [ty, tm, td] = parseDay(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** days_until(E) = studyDay(E.starts_at) − studyDay(now), in whole days (§0.2). */
export function daysUntil(startsAt: Date, now: Date, tz: string = DEFAULT_TIME_ZONE): number {
  return daysBetween(studyDay(now, tz), studyDay(startsAt, tz));
}

/** Later of two LocalDates. */
export function maxDay(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}
