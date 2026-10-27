import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OVERRIDES,
  LONG_PROMPT_THRESHOLD_TOKENS,
  MAX_TOKENS,
  PRICE_VERSION,
  SERVER_FALLBACK_BETA,
  costMicroUsd,
  costUsd,
  effortFor,
  hasServerFallback,
  modelFor,
  nextMaxTokensClass,
  priceFor,
  requiresStreaming,
  syncRequestDefaults,
  zeroUsage,
} from "../src/models.ts";
import { summarizeMessage } from "../src/usage.ts";
import { message } from "./helpers.ts";

describe("cost formula (ai-pipeline §9.3)", () => {
  it("prices every token class with the Haiku 5.5 standard card, in integer micro-USD", () => {
    // input 1000 x $0.10 = $0.0001
    // output 2000 x $0.50 = $0.001
    // cache read 5000 x $0.01 = $0.00005
    // cache write 5m 1000 x $0.125 = $0.000125
    // cache write 1h 500 x $0.20 = $0.0001
    // total = $0.001375 = 1_375 micro-USD (prompt 7_000 tokens: standard card)
    const usage = {
      ...zeroUsage(),
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_tokens: 5_000,
      cache_creation_5m_tokens: 1_000,
      cache_creation_1h_tokens: 500,
    };
    expect(costMicroUsd(usage, { model: DEFAULT_MODEL })).toBe(1_375);
  });

  it("prices Batch requests at half", () => {
    const usage = { ...zeroUsage(), input_tokens: 1_000, output_tokens: 2_000 };
    // $0.0001 + $0.001 = $0.0011 -> 1_100 micro-USD, batch 550
    expect(costMicroUsd(usage, { batch: true, model: DEFAULT_MODEL })).toBe(550);
  });

  it("matches the per-million rates of the standard card for each class", () => {
    // Prompts here stay at 100,000 tokens or less so every class is on the standard card.
    const m = { model: DEFAULT_MODEL };
    expect(costMicroUsd({ ...zeroUsage(), input_tokens: 100_000 }, m)).toBe(10_000);
    expect(costMicroUsd({ ...zeroUsage(), output_tokens: 1_000_000 }, m)).toBe(500_000);
    expect(costMicroUsd({ ...zeroUsage(), cache_read_tokens: 100_000 }, m)).toBe(1_000);
    expect(costMicroUsd({ ...zeroUsage(), cache_creation_5m_tokens: 100_000 }, m)).toBe(12_500);
    expect(costMicroUsd({ ...zeroUsage(), cache_creation_1h_tokens: 100_000 }, m)).toBe(20_000);
  });

  it("rounds to the nearest micro-USD", () => {
    // 1 cache-read token = $0.00000001 = 0.01 micro-USD -> 0
    expect(costMicroUsd({ ...zeroUsage(), cache_read_tokens: 1 }, { model: DEFAULT_MODEL })).toBe(0);
    // 10 input tokens = $0.000001 = 1 micro-USD
    expect(costMicroUsd({ ...zeroUsage(), input_tokens: 10 }, { model: DEFAULT_MODEL })).toBe(1);
  });

  it("prices an unknown model at the most expensive known rate", () => {
    expect(costMicroUsd({ ...zeroUsage(), output_tokens: 1_000_000 }, { model: "claude-unknown-9-9" })).toBe(20_000_000);
    expect(priceFor("claude-unknown-9-9", 500_000).output).toBe(20);
  });

  it("adds web search at the placeholder per-request price", () => {
    // 2 searches x $0.01 = $0.02
    expect(costUsd({ ...zeroUsage(), web_search_requests: 2 }, DEFAULT_MODEL)).toBeCloseTo(0.02, 10);
  });

  it("is stamped with a price version for Haiku 5.5", () => {
    expect(PRICE_VERSION).toMatch(/haiku-5-5/);
  });
});

describe("Haiku 5.5 two-card pricing (prompt length = input + cache read + cache writes)", () => {
  it("uses the standard card at exactly 100,000 prompt tokens", () => {
    expect(LONG_PROMPT_THRESHOLD_TOKENS).toBe(100_000);
    expect(priceFor(DEFAULT_MODEL, 100_000)).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    // 100,000 input tokens x $0.10/MTok = $0.01
    expect(costUsd({ ...zeroUsage(), input_tokens: 100_000 }, DEFAULT_MODEL)).toBeCloseTo(0.01, 12);
  });

  it("uses the long-prompt card at 100,001 prompt tokens", () => {
    expect(priceFor(DEFAULT_MODEL, 100_001)).toMatchObject({ input: 0.5, output: 2.5, cacheRead: 0.05 });
    // 100,001 input tokens x $0.50/MTok = $0.0500005
    expect(costUsd({ ...zeroUsage(), input_tokens: 100_001 }, DEFAULT_MODEL)).toBeCloseTo(0.0500005, 12);
  });

  it("counts cache reads and cache writes toward the prompt length", () => {
    // 50,000 fresh input + 50,001 cache reads = 100,001 prompt tokens -> long card
    const usage = { ...zeroUsage(), input_tokens: 50_000, cache_read_tokens: 50_001 };
    // 50,000 x $0.50/MTok + 50,001 x $0.05/MTok = $0.02750005
    expect(costUsd(usage, DEFAULT_MODEL)).toBeCloseTo(0.02750005, 12);
    // 100,000 total including a 1h cache write stays on the standard card
    const atLimit = { ...zeroUsage(), input_tokens: 0, cache_creation_1h_tokens: 100_000 };
    expect(costUsd(atLimit, DEFAULT_MODEL)).toBeCloseTo(0.02, 12);
  });

  it("uses the long-prompt output rate for a long request", () => {
    const usage = { ...zeroUsage(), input_tokens: 100_002, output_tokens: 1_000_000 };
    // input 100,002 x $0.50/MTok = $0.050001 + output 1M x $2.50/MTok = $2.50 -> 2_550_001 micro-USD
    expect(costMicroUsd(usage, { model: DEFAULT_MODEL })).toBe(2_550_001);
  });
});

describe("model policy and request defaults", () => {
  it("uses claude-haiku-5-5 for every task unless the owner overrides it", () => {
    expect(DEFAULT_MODEL).toBe("claude-haiku-5-5");
    expect(modelFor("cards.generate")).toBe("claude-haiku-5-5");
    expect(modelFor("ingest.outline")).toBe("claude-haiku-5-5");
  });

  it("runs every task at effort high (owner decision 2026-10-27), whatever the prompt's hint says", () => {
    expect(DEFAULT_EFFORT).toBe("high");
    expect(effortFor({ id: "cards.generate" })).toBe("high");
    expect(effortFor({ id: "tutor.route" })).toBe("high");
  });

  it("applies a per-task effort override when one is recorded (owner decision and eval evidence)", () => {
    const overrides = EFFORT_OVERRIDES as Record<string, string>;
    overrides["cards.generate"] = "low";
    try {
      expect(effortFor({ id: "cards.generate" })).toBe("low");
      expect(effortFor({ id: "tutor.route" })).toBe("high");
    } finally {
      delete overrides["cards.generate"];
    }
  });

  it("sends no server-side fallback or beta on Haiku 5.5, and keeps them for the models that have one", () => {
    expect(hasServerFallback(DEFAULT_MODEL)).toBe(false);
    expect(syncRequestDefaults(DEFAULT_MODEL)).toEqual({});
    expect(syncRequestDefaults("claude-opus-5-5")).toEqual({ fallbacks: "default", betas: [SERVER_FALLBACK_BETA] });
    expect(syncRequestDefaults("claude-sonnet-5-5")).toEqual({ fallbacks: "default", betas: [SERVER_FALLBACK_BETA] });
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
    // Haiku 5.5 standard card: 1,375 micro-USD (see the cost formula tests)
    expect(summary.costMicroUsd).toBe(1_375);
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
