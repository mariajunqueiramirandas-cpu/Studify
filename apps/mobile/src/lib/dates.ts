// Calendar helpers. Student days are local dates (YYYY-MM-DD) with a day rollover hour
// (data-model R9, default 4: a study day ends at 04:00).

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date (device timezone) of an instant, as YYYY-MM-DD. */
export function localDateOf(instant: number | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Study day of an instant: the calendar day shifted back by `rolloverHour` hours. */
export function studyDateOf(instant: number | Date, rolloverHour = 4): string {
  const ms = (instant instanceof Date ? instant : new Date(instant)).getTime() - rolloverHour * 3_600_000;
  return localDateOf(ms);
}
