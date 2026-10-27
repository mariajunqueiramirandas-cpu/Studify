import { options, t } from '../../i18n';

// copy-pt-br.md §2 formatting rules. Display helpers only; they never touch stored values.

const pad = (n: number) => String(n).padStart(2, '0');

export function parseDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  // Plain local dates (YYYY-MM-DD) are calendar days, not instants.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

export function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 14/11 */
export function shortDate(value: string | Date): string {
  const d = parseDate(value);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** qua, 14/11 */
export function weekdayDate(value: string | Date): string {
  const d = parseDate(value);
  return `${options('weekdays_short')[d.getDay()]}, ${shortDate(d)}`;
}

export function weekdayLong(value: string | Date): string {
  return options('weekdays_long')[parseDate(value).getDay()] ?? '';
}

/** 14 de novembro (year only when not the current one) */
export function longDate(value: string | Date, now = new Date()): string {
  const d = parseDate(value);
  const month = options('months')[d.getMonth()];
  const base = `${d.getDate()} de ${month}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} de ${d.getFullYear()}`;
}

/** 19:00 */
export function timeHM(value: string | Date): string {
  const d = parseDate(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "às 19h" / "às 19h30" */
export function timeInSentence(value: string | Date): string {
  const d = parseDate(value);
  return d.getMinutes() === 0 ? `${d.getHours()}h` : `${d.getHours()}h${pad(d.getMinutes())}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** "Faltam 3 dias" / "É amanhã!" / "Hoje às 14:00" (ux §6 CountdownChip). */
export function countdown(startsAt: string | Date, hasTime = true, now = new Date()): string {
  const d = parseDate(startsAt);
  const days = daysBetween(now, d);
  if (days < 0) return t('countdown.past');
  if (days === 0) return hasTime ? t('countdown.today', { time: timeHM(d) }) : t('countdown.today_tbd');
  if (days === 1) return t('countdown.tomorrow');
  return t('countdown.days', { n: days });
}

/** "10 min", "3 d", "2 meses" — rating-button intervals (ux §5.1). */
export function shortInterval(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} d`;
  const months = Math.round(d / 30);
  if (months < 12) return `${months} m`;
  return `${(d / 365).toFixed(1).replace('.', ',')} a`;
}

/** "3 dias" — spoken form for TalkBack. */
export function longInterval(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} minutos`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? '1 hora' : `${h} horas`;
  const d = Math.round(h / 24);
  if (d < 31) return d === 1 ? '1 dia' : `${d} dias`;
  const months = Math.round(d / 30);
  return months === 1 ? '1 mês' : `${months} meses`;
}

/** Relative day: hoje, amanhã, ontem, em 3 dias, há 2 dias. */
export function relativeDay(value: string | Date, now = new Date()): string {
  const days = daysBetween(now, parseDate(value));
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  if (days === -1) return 'ontem';
  return days > 0 ? `em ${days} dias` : `há ${-days} dias`;
}

/** Decimal comma (7,5); grades on 0–100 are integers (copy §2). */
export function formatNumber(n: number, decimals = 1): string {
  return n.toFixed(decimals).replace('.', ',');
}

export function formatGrade(n: number | null | undefined, scaleMax = 10): string {
  if (n == null || Number.isNaN(n)) return '—';
  return scaleMax > 10 ? String(Math.round(n)) : formatNumber(n, 1);
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** "25 min", "1h30" */
export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h${pad(m)}`;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${formatNumber(bytes / 1024 ** 2, 1)} MB`;
  return `${formatNumber(bytes / 1024 ** 3, 1)} GB`;
}

export function formatThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function pageLabel(start: number, end?: number | null): string {
  return end && end !== start ? t('global.page_range_chip', { start, end }) : t('global.page_chip', { page: start });
}

export function greeting(name: string, now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return t('today.greeting_morning', { name });
  if (h >= 12 && h < 18) return t('today.greeting_afternoon', { name });
  return t('today.greeting_evening', { name });
}
