// Model policy, request defaults, max_tokens classes and the cost formula.
// Source: docs/engineering/ai-pipeline.md §2.1–§2.3, §9.3; ADR 0003.

import type { MaxTokensClass, UsageTotals } from "./types.ts";

/** ADR 0003: every task runs on this model unless the owner decides otherwise. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Owner-approved per-task overrides. Empty by design: engineering never downgrades a task
 * on its own (ai-pipeline §1.1). Adding an entry needs the owner's decision and eval evidence.
 */
export const MODEL_OVERRIDES: Readonly<Record<string, string>> = {};

export function modelFor(taskId: string): string {
  return MODEL_OVERRIDES[taskId] ?? DEFAULT_MODEL;
}

/** Beta header that enables server-side refusal fallback on synchronous requests (§2.2). */
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Sent on every synchronous request. Rejected on Batch requests (§7.4). */
export const SYNC_REQUEST_DEFAULTS = {
  fallbacks: "default" as const,
  betas: [SERVER_FALLBACK_BETA],
};

/** Anthropic API version the SDK sends (informational; the SDK sets the header). */
export const API_VERSION = "2026-10-21";

export const MAX_TOKENS: Readonly<Record<MaxTokensClass, number>> = {
  XS: 4_000,
  S: 8_000,
  M: 16_000,
  L: 32_000,
  XL: 64_000,
};

const CLASS_ORDER: readonly MaxTokensClass[] = ["XS", "S", "M", "L", "XL"];

/** The next class up, used once when a structured output is truncated (§2.4). */
export function nextMaxTokensClass(cls: MaxTokensClass): MaxTokensClass | null {
  const i = CLASS_ORDER.indexOf(cls);
  return i >= 0 && i < CLASS_ORDER.length - 1 ? (CLASS_ORDER[i + 1] ?? null) : null;
}

/** L and XL must stream on synchronous calls (§2.2). */
export function requiresStreaming(cls: MaxTokensClass): boolean {
  return cls === "L" || cls === "XL";
}

/** Default output estimate per class for budget reservations (§9.1). */
export const DEFAULT_OUTPUT_TOKENS: Readonly<Record<MaxTokensClass, number>> = {
  XS: 1_000,
  S: 3_000,
  M: 8_000,
  L: 16_000,
  XL: 32_000,
};

/** Rough input tokens per PDF page when a slice has no measured token_count (§9.5 estimate). */
export const DEFAULT_TOKENS_PER_PAGE = 2_000;

/** Bump when any price below changes (stored in ai_usage.price_version). */
export const PRICE_VERSION = "2026-10.opus-5-5.v1";

/** USD per million tokens. Verify on the pricing page before launch (§9.3). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": {
    input: 4.0,
    output: 20.0,
    cacheRead: 0.2,
    cacheWrite5m: 4.0 * 1.25,
    cacheWrite1h: 4.0 * 2.0,
  },
};

/**
 * Server-tool prices, USD. PLACEHOLDERS: the pricing page is not available to this build.
 * Verify before launch and bump PRICE_VERSION when changed.
 */
export const SERVER_TOOL_PRICES = {
  webSearchPerRequest: 0.01,
  codeExecutionPerHour: 0.05,
} as const;

/** Batch API discount (applied to every token and server-tool charge). */
export const BATCH_DISCOUNT = 0.5;

export function isPriceKnown(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICES, model);
}

/**
 * Unknown models (for example a server-side fallback model whose rates are not in the table)
 * are priced at the most expensive known rate so budgets are never under-counted.
 */
export function priceFor(model: string): ModelPrice {
  const known = PRICES[model];
  if (known) return known;
  let max = PRICES[DEFAULT_MODEL] as ModelPrice;
  for (const p of Object.values(PRICES)) {
    if (p.output > max.output) max = p;
  }
  return max;
}

/** Cost in USD before the batch discount (ai-pipeline §9.3). */
export function costUsd(u: UsageTotals, model: string): number {
  const p = priceFor(model);
  const tokensUsd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_tokens * p.cacheRead +
      u.cache_creation_5m_tokens * p.cacheWrite5m +
      u.cache_creation_1h_tokens * p.cacheWrite1h) /
    1e6;
  const toolsUsd =
    u.web_search_requests * SERVER_TOOL_PRICES.webSearchPerRequest +
    (u.code_execution_seconds / 3600) * SERVER_TOOL_PRICES.codeExecutionPerHour;
  return tokensUsd + toolsUsd;
}

/**
 * Integer micro-USD for ai_usage.cost_micro_usd and budgets (ai-pipeline §9.3):
 * round(usd × (batch ? 0.5 : 1) × 1e6).
 */
export function costMicroUsd(
  u: UsageTotals,
  opts: { batch?: boolean; model?: string } = {},
): number {
  const usd = costUsd(u, opts.model ?? DEFAULT_MODEL);
  return Math.round(usd * (opts.batch ? BATCH_DISCOUNT : 1) * 1e6);
}

export function zeroUsage(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    web_search_requests: 0,
    code_execution_seconds: 0,
  };
}
