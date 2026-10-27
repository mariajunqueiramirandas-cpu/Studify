// pt-BR formatting helpers. Deterministic string building (no Intl) so output is identical on
// Hermes builds with and without full ICU.
import { localDateOf } from './dates';

const DAY_MS = 24 * 60 * 60 * 1000;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whole calendar days from `from` to `to` (both interpreted in local time). Negative if `to` is earlier. */
export function calendarDaysBetween(from: Date | number, to: Date | number): number {
  const a = Date.UTC(...ymd(from));
  const b = Date.UTC(...ymd(to));
  return Math.round((b - a) / DAY_MS);
}

function ymd(value: Date | number): [number, number, number] {
  const [y, m, d] = localDateOf(value).split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** "hoje", "amanhã", "ontem", "em 3 dias", "há 3 dias". */
export function formatRelativeDays(target: Date | number, now: Date | number = Date.now()): string {
  const diff = calendarDaysBetween(now, target);
  if (diff === 0) return 'hoje';
  if (diff === 1) return 'amanhã';
  if (diff === -1) return 'ontem';
  if (diff > 1) return `em ${plural(diff, 'dia', 'dias')}`;
  return `há ${plural(-diff, 'dia', 'dias')}`;
}

/**
 * Review interval in days as shown on rating buttons: "menos de 1 dia", "1 dia", "3 dias",
 * "2 meses", "1 ano". FSRS intervals are in days; sub-day learning steps pass fractional days.
 */
export function formatInterval(days: number): string {
  if (!Number.isFinite(days) || days < 1) return 'menos de 1 dia';
  const d = Math.round(days);
  if (d < 30) return plural(d, 'dia', 'dias');
  if (d < 365) return plural(Math.round(d / 30), 'mês', 'meses');
  return plural(Math.round(d / 365), 'ano', 'anos');
}

/** Time until a due instant for short horizons: "agora", "em 10 min", "em 3 h", otherwise formatRelativeDays. */
export function formatDueIn(due: Date | number, now: Date | number = Date.now()): string {
  const dueMs = due instanceof Date ? due.getTime() : due;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const diffMin = Math.round((dueMs - nowMs) / 60_000);
  if (diffMin <= 0) return 'agora';
  if (diffMin < 60) return `em ${diffMin} min`;
  if (diffMin < 24 * 60) return `em ${Math.round(diffMin / 60)} h`;
  return formatRelativeDays(due, now);
}

/**
 * Grade with a decimal comma: 7.5 -> "7,5", 10 -> "10". With `max`: "7,5 / 10".
 * Rounds to `decimals` (default 2) and drops trailing zeros.
 */
export function formatGrade(value: number, max?: number, decimals = 2): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  const text = String(rounded).replace('.', ',');
  return max === undefined ? text : `${text} / ${String(max).replace('.', ',')}`;
}

/** Relative time of an instant for "Sincronizado há 3 min" style labels. */
export function formatAgo(instant: Date | number, now: Date | number = Date.now()): string {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const thenMs = instant instanceof Date ? instant.getTime() : instant;
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${plural(minutes, 'min', 'min')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${plural(hours, 'hora', 'horas')}`;
  return formatRelativeDays(instant, now);
}
