// Private helpers for the planning module. Not re-exported from index.ts.
// Calendar math is pure UTC arithmetic on 'YYYY-MM-DD' strings, so it never depends on the
// host time zone or on Date.now().

/** Numeric tolerance for comparisons against grades and targets (avoids 5.999999999 ≥ 6 misses). */
export const EPS = 1e-9;

export function clean(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function ceil5(x: number): number {
  return Math.ceil(x / 5 - EPS) * 5;
}

export function parseDay(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parseDay(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function dayDiff(from: string, to: string): number {
  const [y1, m1, d1] = parseDay(from);
  const [y2, m2, d2] = parseDay(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday (matches `study_preferences.minutes_by_weekday`). */
export function weekdayMon0(day: string): number {
  const [y, m, d] = parseDay(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function hhmmToMin(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export function minToHHMM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Rounds `v` to a multiple of `step` using the policy of learning-engine §14.1. */
export function roundPolicy(v: number, mode: 'none' | 'round_half_up' | 'ceil' | 'floor', step: number): number {
  if (mode === 'none') return v;
  const q = v / step;
  let k: number;
  if (mode === 'round_half_up') k = Math.floor(q + 0.5 + EPS);
  else if (mode === 'ceil') k = Math.ceil(q - EPS);
  else k = Math.floor(q + EPS);
  return clean(k * step);
}

/** Canonical JSON (sorted keys, undefined dropped) so hashes do not depend on property order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Largest-remainder allocation of `total` integer units over non-negative weights (ties by index). */
export function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const base = Math.floor(total / weights.length);
    const out = weights.map(() => base);
    for (let i = 0; i < total - base * weights.length; i++) out[i] = (out[i] ?? 0) + 1;
    return out;
  }
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    rest--;
  }
  return out;
}
