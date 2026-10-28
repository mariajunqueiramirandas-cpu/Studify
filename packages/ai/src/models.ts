// Model policy, request defaults, max_tokens classes and the cost formula.
// Source: docs/engineering/ai-pipeline.md §1, §2.1–§2.3, §9.3; ADR 0003 and its 2026-10-27 amendment.

import type { Effort, MaxTokensClass, UsageTotals } from "./types.ts";

/**
 * Owner decision 2026-10-27: every task runs on Claude Haiku 5.5 at effort "high". This replaces
 * the Opus 5.5 default of ADR 0003. Haiku 5.5 has no server-side refusal fallback (see
 * SERVER_FALLBACK_MODELS below).
 */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * Owner-approved per-task model overrides. Empty by design: engineering never downgrades or
 * upgrades a task on its own (ai-pipeline §1.1). Adding an entry needs the owner's decision and
 * eval evidence.
 */
export const MODEL_OVERRIDES: Readonly<Record<string, string>> = {};

export function modelFor(taskId: string): string {
  return Object.prototype.hasOwnProperty.call(MODEL_OVERRIDES, taskId)
    ? (MODEL_OVERRIDES[taskId] as string)
    : DEFAULT_MODEL;
}

/**
 * Owner decision 2026-10-27 (later the same day): each task runs at the effort its prompt declares, capped
 * at "medium". "high" doubled the time of every call (hidden thinking) for the same visible output.
 */
export const MAX_EFFORT: Effort = "medium";

/** Effort for a task that declares none. */
export const DEFAULT_EFFORT: Effort = "medium";

const EFFORT_RANK: Readonly<Record<Effort, number>> = { low: 0, medium: 1, high: 2 };

/**
 * Per-task effort overrides, applied as is (above the cap too). Empty by design; same rule as
 * MODEL_OVERRIDES: owner decision plus eval evidence (ai-pipeline §2.2).
 */
export const EFFORT_OVERRIDES: Readonly<Record<string, Effort>> = {};

/** The effort sent as output_config.effort for this task. Used by request.ts, callClaude.ts, batch.ts and usage rows. */
export function effortFor(task: { id: string; effort?: Effort }): Effort {
  if (Object.prototype.hasOwnProperty.call(EFFORT_OVERRIDES, task.id)) return EFFORT_OVERRIDES[task.id] as Effort;
  const declared = task.effort ?? DEFAULT_EFFORT;
  return EFFORT_RANK[declared] > EFFORT_RANK[MAX_EFFORT] ? MAX_EFFORT : declared;
}

/** Beta header that enables server-side refusal fallback on synchronous requests (§2.2). */
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Models that support the server-side refusal fallback (`fallbacks: "default"` plus the beta).
 * Haiku 5.5 is not listed: it rejects `fallbacks` with 400, and refusals arrive as HTTP 200 with
 * stop_reason "refusal" that the wrapper maps to ai_refused.
 */
export const SERVER_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
]);

export function hasServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model);
}

/**
 * Extra params for a synchronous (non-Batch) request to `model`. Batch requests never get them
 * (§7.4). Models without a server-side fallback get nothing.
 */
export function syncRequestDefaults(model: string): { fallbacks?: "default"; betas?: string[] } {
  return hasServerFallback(model) ? { fallbacks: "default", betas: [SERVER_FALLBACK_BETA] } : {};
}

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

/**
 * The max_tokens class a request is sent with. Structured output gets the next class up front, because a cut-off
 * JSON is lost and nothing re-asks (one paid request per call); max_tokens is a ceiling, only written tokens are
 * billed. Prose keeps its class: a cut-off answer keeps its text (TUT-01).
 */
export function requestMaxTokensClass(task: { maxTokensClass: MaxTokensClass; output: { mode: string } }): MaxTokensClass {
  return task.output.mode === "structured" ? (nextMaxTokensClass(task.maxTokensClass) ?? task.maxTokensClass) : task.maxTokensClass;
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
export const PRICE_VERSION = "2026-10.haiku-5-5.v1";

/** USD per million tokens. Verify on the pricing page before launch (§9.3). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * Prompt length above which a model's long-prompt rate card applies. Prompt length is
 * input_tokens + cache_read_tokens + cache_creation tokens of one request. A prompt of exactly
 * 100,000 tokens is still billed at the standard card.
 */
export const LONG_PROMPT_THRESHOLD_TOKENS = 100_000;

/** Standard rate card per model (prompt ≤ LONG_PROMPT_THRESHOLD_TOKENS where a second card exists). */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": {
    input: 4.0,
    output: 20.0,
    cacheRead: 0.2,
    cacheWrite5m: 4.0 * 1.25,
    cacheWrite1h: 4.0 * 2.0,
  },
  // Owner decision 2026-10-27. Cache reads 0.1x input, 5-minute writes 1.25x, 1-hour writes 2x.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
  },
};

/** Long-prompt rate cards (prompt > LONG_PROMPT_THRESHOLD_TOKENS). Models absent here have one card. */
export const LONG_PROMPT_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-5-5": {
    input: 0.5,
    output: 2.5,
    cacheRead: 0.05,
    cacheWrite5m: 0.625,
    cacheWrite1h: 1.0,
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

function lookup(table: Readonly<Record<string, ModelPrice>>, model: string): ModelPrice | undefined {
  return Object.prototype.hasOwnProperty.call(table, model) ? table[model] : undefined;
}

/** Most expensive known output rate across every card. Used for models with no price row. */
const MOST_EXPENSIVE: ModelPrice = [...Object.values(PRICES), ...Object.values(LONG_PROMPT_PRICES)].reduce(
  (max, p) => (p.output > max.output ? p : max),
);

/** Prompt length of one request: fresh input, cache reads and cache writes (both TTLs). */
export function promptTokensOf(u: UsageTotals): number {
  return u.input_tokens + u.cache_read_tokens + u.cache_creation_5m_tokens + u.cache_creation_1h_tokens;
}

/**
 * Rate card for one request. Unknown models are priced at the most expensive known rate so
 * budgets are never under-counted.
 */
export function priceFor(model: string, promptTokens = 0): ModelPrice {
  if (promptTokens > LONG_PROMPT_THRESHOLD_TOKENS) {
    const long = lookup(LONG_PROMPT_PRICES, model);
    if (long) return long;
  }
  return lookup(PRICES, model) ?? MOST_EXPENSIVE;
}

/** Cost in USD before the batch discount (ai-pipeline §9.3). */
export function costUsd(u: UsageTotals, model: string): number {
  const p = priceFor(model, promptTokensOf(u));
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
