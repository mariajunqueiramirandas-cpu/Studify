import { addDays, dayDiff } from './util.ts';

/**
 * Study day of an instant (learning-engine §0.2, MEM-02.13): activity before the rollover hour
 * belongs to the previous study day. The only planning function that reads a time zone; it uses
 * Intl, which Hermes supports for `timeZone` on current RN releases. Callers that cannot use Intl
 * can pass the local date and hour themselves to the rest of this module.
 */
export function planStudyDayOf(epochMs: number, timeZone: string, rolloverHour = 4): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return Number(get('hour')) < rolloverHour ? addDays(day, -1) : day;
}

/** `days_until(E)` of learning-engine §0.2: whole study days from `today` to the exam's local date. */
export function planDaysUntil(examLocalDate: string, today: string): number {
  return dayDiff(today, examLocalDate);
}
