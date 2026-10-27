import { describe, expect, it } from 'vitest';
import {
  MICRO_USD_PER_USD,
  aiUsageHeaderValue,
  assertMicroUsd,
  formatPercentPtBr,
  formatUsdPtBr,
  microToUsd,
  sumMicroUsd,
  tokenCostMicroUsd,
  usagePercent,
  usdToMicro,
} from '../../src/core/money.ts';

describe('micro-USD arithmetic', () => {
  it('converts USD and back', () => {
    expect(MICRO_USD_PER_USD).toBe(1_000_000);
    expect(usdToMicro(0.0123)).toBe(12_300);
    expect(usdToMicro(4)).toBe(4_000_000);
    expect(microToUsd(2_500_000)).toBe(2.5);
  });

  it('rejects non-integer, negative and non-finite amounts', () => {
    expect(() => assertMicroUsd(-1)).toThrow(RangeError);
    expect(() => assertMicroUsd(1.5)).toThrow(RangeError);
    expect(() => usdToMicro(Number.NaN)).toThrow(RangeError);
    expect(() => sumMicroUsd([Number.MAX_SAFE_INTEGER, 10])).toThrow(RangeError);
  });

  it('prices tokens per million with the Batch discount applied once at the end', () => {
    const prices = { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 };
    expect(tokenCostMicroUsd({ input: 1_000_000, output: 0 }, prices)).toBe(4_000_000);
    expect(tokenCostMicroUsd({ input: 1_000_000, output: 0 }, prices, { batch: true })).toBe(2_000_000);
    expect(tokenCostMicroUsd({ input: 0, output: 0, cacheRead: 5_000_000 }, prices)).toBe(1_000_000);
  });
});

describe('PT-BR formatting', () => {
  it('formats currency with dot thousands and comma decimals', () => {
    expect(formatUsdPtBr(1_234_560_000)).toBe('US$ 1.234,56');
    expect(formatUsdPtBr(0)).toBe('US$ 0,00');
    expect(formatUsdPtBr(12_345, { digits: 4 })).toBe('US$ 0,0123');
    expect(formatUsdPtBr(1_500_000, { digits: 0 })).toBe('US$ 2'); // half rounds up
    expect(formatUsdPtBr(-2_000_000)).toBe('-US$ 2,00');
  });

  it('formats percents with no space before the sign', () => {
    expect(formatPercentPtBr(62.4)).toBe('62%');
    expect(formatPercentPtBr(99.6)).toBe('100%');
  });
});

describe('usage percent (x-ai-usage-today header, PLT-04.2)', () => {
  it('rounds down and clamps at 100', () => {
    expect(usagePercent(80_000_000, 100_000_000)).toBe(80);
    expect(usagePercent(1, 3)).toBe(33);
    expect(usagePercent(101, 100)).toBe(100);
  });

  it('treats a zero limit as used up once anything is spent', () => {
    expect(usagePercent(0, 0)).toBe(0);
    expect(usagePercent(5, 0)).toBe(100);
  });

  it('header value is a plain integer string', () => {
    expect(aiUsageHeaderValue(1, 3)).toBe('33');
  });
});
