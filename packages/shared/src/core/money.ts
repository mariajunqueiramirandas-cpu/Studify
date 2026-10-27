// AI cost arithmetic. All money is integer micro-dollars (1 USD = 1,000,000 micro-USD), stored as
// bigint in Postgres (`*_micro_usd`, data-model §1.1). Floats are only used at the USD edge.
// Formatting is done by hand so Hermes, Deno and Node print identical PT-BR strings.
//
// Students never see money (copy-pt-br §2 "Money", PLT-04.2). Use these helpers for admin and
// moderator screens (PLT-04.6) and for logs. For students use `usagePercent` (the `x-ai-usage-today`
// header, api §2.5).

export const MICRO_USD_PER_USD = 1_000_000;

function assertSafeMicro(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer number of micro-USD`);
  }
}

/** Asserts a value is a non-negative integer micro-USD amount. Returns it unchanged. */
export function assertMicroUsd(value: number): number {
  assertSafeMicro(value, 'micro-USD amount');
  if (value < 0) throw new RangeError('micro-USD amount must not be negative');
  return value;
}

/** Converts USD to micro-USD, rounding half up to the nearest micro-dollar. */
export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd)) throw new RangeError('usd must be finite');
  const micro = Math.round(usd * MICRO_USD_PER_USD);
  assertSafeMicro(micro, 'usdToMicro result');
  return micro;
}

/** Converts micro-USD to a USD number (for display arithmetic only, never for storage). */
export function microToUsd(micro: number): number {
  assertSafeMicro(micro, 'micro-USD amount');
  return micro / MICRO_USD_PER_USD;
}

/** Sums micro-USD amounts with overflow checking. */
export function sumMicroUsd(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertSafeMicro(v, 'micro-USD amount');
    total += v;
    assertSafeMicro(total, 'micro-USD sum');
  }
  return total;
}

/**
 * Cost of a call in micro-USD from per-million-token prices (ai-pipeline §9.3 shape).
 * `batch` applies the 50% Batch API discount. Result is rounded once, at the end.
 */
export function tokenCostMicroUsd(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  prices: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number },
  options: { batch?: boolean } = {},
): number {
  const usd =
    (tokens.input * prices.inputPerMTok +
      tokens.output * prices.outputPerMTok +
      (tokens.cacheRead ?? 0) * (prices.cacheReadPerMTok ?? 0) +
      (tokens.cacheWrite ?? 0) * (prices.cacheWritePerMTok ?? 0)) /
    1_000_000;
  return usdToMicro(usd * (options.batch ? 0.5 : 1));
}

/**
 * Integer percent of a limit used, clamped to 0–100 (rounded down so 100 means fully used).
 * A zero limit counts as fully used once anything is spent.
 */
export function usagePercent(spentMicro: number, limitMicro: number): number {
  assertMicroUsd(spentMicro);
  assertMicroUsd(limitMicro);
  if (limitMicro === 0) return spentMicro > 0 ? 100 : 0;
  return Math.min(100, Math.floor((spentMicro * 100) / limitMicro));
}

/** Value of the `x-ai-usage-today` response header (api §2.5). */
export function aiUsageHeaderValue(spentMicro: number, limitMicro: number): string {
  return String(usagePercent(spentMicro, limitMicro));
}

function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Formats micro-USD as PT-BR currency: `US$ 1.234,56`. `digits` is the number of decimal places
 * (2 for totals, up to 6 for per-call costs). Rounds half up at that precision.
 */
export function formatUsdPtBr(micro: number, options: { digits?: number } = {}): string {
  assertSafeMicro(micro, 'micro-USD amount');
  const digits = options.digits ?? 2;
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
    throw new RangeError('digits must be an integer 0–6');
  }
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const unit = 10 ** (6 - digits);
  const scaled = Math.floor(abs / unit + 0.5); // integer amount in 10^-digits USD
  const scale = 10 ** digits;
  const intPart = Math.floor(scaled / scale);
  const fracPart = scaled % scale;
  const intText = groupThousands(String(intPart));
  const body = digits === 0 ? intText : `${intText},${String(fracPart).padStart(digits, '0')}`;
  return `${sign}US$ ${body}`;
}

/** Integer percent with no space before the sign: "62%" (copy-pt-br §2). */
export function formatPercentPtBr(percent: number): string {
  if (!Number.isFinite(percent)) throw new RangeError('percent must be finite');
  return `${Math.round(percent)}%`;
}
