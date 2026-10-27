// Study-day and calendar helpers. Built on Intl only (no date libraries) so the same code runs in
// Hermes, Deno and Node. `studyDayOf` is the only function allowed to turn an instant into a study
// day (learning-engine §0.2). Instants are UTC; "local" means the student's time zone.

/** profiles.timezone default (data-model §5.1). */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';
/** R9 / MEM-02.13: a study day runs 04:00 → 04:00 local. */
export const DEFAULT_DAY_ROLLOVER_HOUR = 4;
/** architecture §5: AI budgets reset at local midnight, independent of the study day. */
export const AI_BUDGET_ROLLOVER_HOUR = 0;
/** ADR 0007 §6 / mobile-app §4.3: device timestamps are clamped when they drift more than 5 min. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type LocalDate = string; // YYYY-MM-DD in the student's time zone
export type LocalTime = string; // HH:mm in the student's time zone

export interface WallClock {
  date: LocalDate;
  hour: number; // 0–23
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
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
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** True when the runtime knows the IANA zone (Intl throws RangeError otherwise). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function toMs(instant: Date | number): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('time: invalid instant');
  return ms;
}

/** Wall-clock fields of an instant in `timeZone`. */
export function wallClockOf(instant: Date | number, timeZone: string = DEFAULT_TIME_ZONE): WallClock {
  const ms = toMs(instant);
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };
  return {
    date: `${pad(get('year'), 4)}-${pad(get('month'))}-${pad(get('day'))}`,
    // Some engines render midnight as 24 even with h23; normalize.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Calendar date (YYYY-MM-DD) of an instant in `timeZone`, ignoring the study-day rollover. */
export function localDateOf(instant: Date | number, timeZone: string = DEFAULT_TIME_ZONE): LocalDate {
  return wallClockOf(instant, timeZone).date;
}

/** "HH:mm" of an instant in `timeZone`. */
export function localTimeOf(instant: Date | number, timeZone: string = DEFAULT_TIME_ZONE): LocalTime {
  const w = wallClockOf(instant, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** Adds whole days to a civil date (no time zone involved). */
export function addDays(day: LocalDate, delta: number): LocalDate {
  if (!isLocalDate(day)) throw new RangeError(`time: not a YYYY-MM-DD date: ${String(day)}`);
  if (!Number.isInteger(delta)) throw new RangeError('time: delta must be an integer');
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole civil days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  if (!isLocalDate(from) || !isLocalDate(to)) throw new RangeError('time: daysBetween needs YYYY-MM-DD dates');
  return Math.round((utcMidnightOf(to) - utcMidnightOf(from)) / 86_400_000);
}

/** UTC midnight of a civil date, used only for calendar arithmetic. */
function utcMidnightOf(day: LocalDate): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function offsetMs(instantMs: number, timeZone: string): number {
  const w = wallClockOf(instantMs, timeZone);
  const [y, m, d] = w.date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to the UTC instant. Handles DST transitions with a
 * second offset lookup. For a non-existent local time (spring-forward gap) the result is the instant
 * just after the gap.
 */
export function wallTimeToInstant(
  day: LocalDate,
  hour: number,
  minute: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date {
  if (!isLocalDate(day)) throw new RangeError(`time: not a YYYY-MM-DD date: ${String(day)}`);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const o1 = offsetMs(wall, timeZone);
  let t = wall - o1;
  const o2 = offsetMs(t, timeZone);
  if (o2 !== o1) t = wall - o2;
  return new Date(t);
}

function assertRollover(rolloverHour: number): void {
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    throw new RangeError('time: rolloverHour must be an integer 0–23');
  }
}

/**
 * The study day an instant belongs to (MEM-02.13, PLT-03). Activity before `rolloverHour` belongs to
 * the previous day: 01:30 on 2026-10-27 is study day 2026-10-26; 04:00 is 2026-10-27.
 */
export function studyDayOf(
  instant: Date | number,
  timeZone: string = DEFAULT_TIME_ZONE,
  rolloverHour: number = DEFAULT_DAY_ROLLOVER_HOUR,
): LocalDate {
  assertRollover(rolloverHour);
  const w = wallClockOf(instant, timeZone);
  return w.hour < rolloverHour ? addDays(w.date, -1) : w.date;
}

/** Instant at which study day `day` starts (its rollover hour, local). */
export function startOfStudyDay(
  day: LocalDate,
  timeZone: string = DEFAULT_TIME_ZONE,
  rolloverHour: number = DEFAULT_DAY_ROLLOVER_HOUR,
): Date {
  assertRollover(rolloverHour);
  return wallTimeToInstant(day, rolloverHour, 0, timeZone);
}

/** Half-open interval [start, end) covering study day `day`. */
export function studyDayBounds(
  day: LocalDate,
  timeZone: string = DEFAULT_TIME_ZONE,
  rolloverHour: number = DEFAULT_DAY_ROLLOVER_HOUR,
): { start: Date; end: Date } {
  return {
    start: startOfStudyDay(day, timeZone, rolloverHour),
    end: startOfStudyDay(addDays(day, 1), timeZone, rolloverHour),
  };
}

/** AI budget day of an instant: the calendar day, since budgets reset at local midnight (PLT-04). */
export function aiBudgetDayOf(instant: Date | number, timeZone: string = DEFAULT_TIME_ZONE): LocalDate {
  return localDateOf(instant, timeZone);
}

/** Instant at which the AI budget day starts (local midnight). */
export function startOfAiBudgetDay(day: LocalDate, timeZone: string = DEFAULT_TIME_ZONE): Date {
  return startOfStudyDay(day, timeZone, AI_BUDGET_ROLLOVER_HOUR);
}

/** Minutes after local midnight for an "HH:mm" string, or null when malformed. */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Whether local time `at` falls in the quiet window [start, end). The window may wrap midnight
 * (default 22:00–07:00). A zero-length window is never quiet. PLT-05.3.
 */
export function isInQuietHours(at: LocalTime, start: LocalTime, end: LocalTime): boolean {
  const t = minutesOfDay(at);
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (t === null || s === null || e === null) throw new RangeError('time: quiet hours must be HH:mm');
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * Clamps a client `reviewed_at` (ADR 0007 §6). A reading more than 5 min in the future is replaced
 * by server receipt time and flagged `clock_skew`. Past readings are kept (offline reviews).
 */
export function clampReviewedAt(
  clientMs: number,
  serverMs: number,
  toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS,
): { reviewedAtMs: number; clockSkew: boolean } {
  if (clientMs > serverMs + toleranceMs) return { reviewedAtMs: serverMs, clockSkew: true };
  return { reviewedAtMs: clientMs, clockSkew: false };
}

/** Clamps a last-writer-wins timestamp into [server − tolerance, server + tolerance] (mobile-app §4.3). */
export function clampLwwTimestamp(
  clientMs: number,
  serverMs: number,
  toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS,
): number {
  return Math.min(Math.max(clientMs, serverMs - toleranceMs), serverMs + toleranceMs);
}
