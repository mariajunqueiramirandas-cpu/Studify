// Small pure numeric helpers shared by the learning modules. Not part of the public API.

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

/** Round half up to a multiple of `step`, without binary-float noise in the result. */
export function roundToStep(x: number, step: number): number {
  return Number((Math.round(x / step) * step).toFixed(10));
}

/** Round to one decimal, half up. Used for displayed grades ("7,0"). */
export function round1(x: number): number {
  return roundToStep(x, 0.1);
}

/**
 * Largest-remainder apportionment (§6.4). Splits `total` integer units proportionally to
 * `weights`; ties on the fractional part go to the lower index, so the result is deterministic.
 */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const n = weights.length;
  if (n === 0 || total <= 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    const base = Math.floor(total / n);
    const extra = total - base * n;
    return weights.map((_, i) => base + (i < extra ? 1 : 0));
  }
  const quotas = weights.map((w) => (w / sum) * total);
  const out = quotas.map((q) => Math.floor(q));
  const remainder = total - out.reduce((a, b) => a + b, 0);
  const order = quotas
    .map((q, i) => ({ i, frac: q - Math.floor(q) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k++) {
    const idx = order[k % n]?.i ?? 0;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
