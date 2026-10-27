import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  MAX_TOKENS,
  PRICE_VERSION,
  costMicroUsd,
  costUsd,
  modelFor,
  nextMaxTokensClass,
  requiresStreaming,
  zeroUsage,
} from "../src/models.ts";
import { summarizeMessage } from "../src/usage.ts";
import { message } from "./helpers.ts";

describe("cost formula (ai-pipeline §9.3)", () => {
  it("prices every token class with the opus-5-5 rates, in integer micro-USD", () => {
    // input 1000 x $4 = $0.004
    // output 2000 x $20 = $0.040
    // cache read 5000 x $0.20 = $0.001
    // cache write 5m 1000 x $5 = $0.005
    // cache write 1h 500 x $8 = $0.004
    // total = $0.054 = 54_000 micro-USD
    const usage = {
      ...zeroUsage(),
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_tokens: 5_000,
      cache_creation_5m_tokens: 1_000,
      cache_creation_1h_tokens: 500,
    };
    expect(costMicroUsd(usage)).toBe(54_000);
  });

  it("halves the total for Batch requests", () => {
    const usage = {
      ...zeroUsage(),
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_tokens: 5_000,
      cache_creation_5m_tokens: 1_000,
      cache_creation_1h_tokens: 500,
    };
    expect(costMicroUsd(usage, { batch: true })).toBe(27_000);
  });

  it("matches the per-million rates for each class on their own", () => {
    expect(costMicroUsd({ ...zeroUsage(), input_tokens: 1_000_000 })).toBe(4_000_000);
    expect(costMicroUsd({ ...zeroUsage(), output_tokens: 1_000_000 })).toBe(20_000_000);
    expect(costMicroUsd({ ...zeroUsage(), cache_read_tokens: 1_000_000 })).toBe(200_000);
    expect(costMicroUsd({ ...zeroUsage(), cache_creation_5m_tokens: 1_000_000 })).toBe(5_000_000);
    expect(costMicroUsd({ ...zeroUsage(), cache_creation_1h_tokens: 1_000_000 })).toBe(8_000_000);
  });

  it("rounds to the nearest micro-USD", () => {
    // 1 cache-read token = $0.0000002 = 0.2 micro-USD -> 0
    expect(costMicroUsd({ ...zeroUsage(), cache_read_tokens: 1 })).toBe(0);
    // 1 input token = $0.000004 = 4 micro-USD
    expect(costMicroUsd({ ...zeroUsage(), input_tokens: 1 })).toBe(4);
    // 1 output token at batch rate = $0.00001 = 10 micro-USD
    expect(costMicroUsd({ ...zeroUsage(), output_tokens: 1 }, { batch: true })).toBe(10);
  });

  it("prices an unknown model at the most expensive known rate", () => {
    expect(costMicroUsd({ ...zeroUsage(), output_tokens: 1_000_000 }, { model: "claude-haiku-5-5" })).toBe(20_000_000);
  });

  it("adds web search at the placeholder per-request price", () => {
    // 2 searches x $0.01 = $0.02
    expect(costUsd({ ...zeroUsage(), web_search_requests: 2 }, DEFAULT_MODEL)).toBeCloseTo(0.02, 10);
  });

  it("is stamped with a price version", () => {
    expect(PRICE_VERSION).toMatch(/opus-5-5/);
  });
});

describe("model policy and request defaults", () => {
  it("uses claude-opus-5-5 for every task unless the owner overrides it", () => {
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
    expect(modelFor("cards.generate")).toBe("claude-opus-5-5");
    expect(modelFor("ingest.outline")).toBe("claude-opus-5-5");
  });

  it("keeps the max_tokens classes from §2.3", () => {
    expect(MAX_TOKENS).toEqual({ XS: 4_000, S: 8_000, M: 16_000, L: 32_000, XL: 64_000 });
  });

  it("walks up one class on truncation and stops at XL", () => {
    expect(nextMaxTokensClass("S")).toBe("M");
    expect(nextMaxTokensClass("L")).toBe("XL");
    expect(nextMaxTokensClass("XL")).toBeNull();
  });

  it("requires streaming for L and XL only", () => {
    expect(requiresStreaming("M")).toBe(false);
    expect(requiresStreaming("L")).toBe(true);
    expect(requiresStreaming("XL")).toBe(true);
  });
});

describe("per-response cost summary", () => {
  it("reads the cache TTL breakdown when present", () => {
    const msg = message({
      usage: { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 5_000, cache_creation_5m_tokens: 1_000, cache_creation_1h_tokens: 500 },
    });
    const summary = summarizeMessage(msg, false);
    expect(summary.totals.cache_creation_5m_tokens).toBe(1_000);
    expect(summary.totals.cache_creation_1h_tokens).toBe(500);
    expect(summary.costMicroUsd).toBe(54_000);
  });

  it("prices each fallback iteration at its own model's rates and sums them", () => {
    const base = message({ usage: { input_tokens: 1_000, output_tokens: 0 } }) as unknown as {
      usage: Record<string, unknown>;
    };
    base.usage.iterations = [
      { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 1_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      { type: "message", model: "claude-opus-5-5", input_tokens: 1_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
    ];
    const summary = summarizeMessage(base as never, false);
    // each attempt: 1000 x $4 + 1000 x $20 = $0.024 -> 48_000 micro-USD
    expect(summary.costMicroUsd).toBe(48_000);
    expect(summary.fallbackUsed).toBe(true);
    expect(summary.totals.output_tokens).toBe(2_000);
  });
});
