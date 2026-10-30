// Normalizes API usage into pricing totals, computes per-response cost, and builds ai_usage rows.
// Runtime-neutral.

import { PRICE_VERSION, costMicroUsd, costUsd, zeroUsage, BATCH_DISCOUNT, effortFor, modelFor } from "./models.ts";
import type {
  AiUsageRow,
  BetaMessage,
  BetaUsage,
  BudgetContext,
  CallMode,
  UsageTotals,
} from "./types.ts";

/** The usage fields we read. Structural, so fakes and the real SDK both fit. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
}

export function totalsFromUsage(u: UsageLike): UsageTotals {
  const totals = zeroUsage();
  totals.input_tokens = u.input_tokens ?? 0;
  totals.output_tokens = u.output_tokens ?? 0;
  totals.cache_read_tokens = u.cache_read_input_tokens ?? 0;
  if (u.cache_creation) {
    totals.cache_creation_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
    totals.cache_creation_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
  } else {
    // Without the TTL breakdown, count creation as the default 5-minute TTL.
    totals.cache_creation_5m_tokens = u.cache_creation_input_tokens ?? 0;
  }
  totals.web_search_requests = u.server_tool_use?.web_search_requests ?? 0;
  return totals;
}

interface IterationLike extends UsageLike {
  type: string;
  model?: string | null;
}

export interface MessageSummary {
  /** Sum over all billed attempts (fallback iterations included). */
  totals: UsageTotals;
  /** Model that produced the final content. */
  modelServed: string;
  fallbackUsed: boolean;
  costMicroUsd: number;
}

/**
 * Cost and totals for one response. When the response carries per-attempt iterations (a server
 * side fallback), each attempt is priced at its own model's rates.
 */
export function summarizeMessage(message: BetaMessage, batch: boolean): MessageSummary {
  const usage = message.usage as BetaUsage & { iterations?: IterationLike[] | null };
  const iterations = usage.iterations ?? [];
  const hasFallbackBlock = message.content.some((b) => b.type === "fallback");
  const hasFallbackIteration = iterations.some((it) => it.type === "fallback_message");
  const fallbackUsed = hasFallbackBlock || hasFallbackIteration;

  if (iterations.length > 0) {
    const totals = zeroUsage();
    let usd = 0;
    for (const it of iterations) {
      const t = totalsFromUsage(it);
      addInto(totals, t);
      usd += costUsd(t, it.model ?? message.model);
    }
    return {
      totals,
      modelServed: message.model,
      fallbackUsed,
      costMicroUsd: Math.round(usd * (batch ? BATCH_DISCOUNT : 1) * 1e6),
    };
  }

  const totals = totalsFromUsage(usage);
  return {
    totals,
    modelServed: message.model,
    fallbackUsed,
    costMicroUsd: costMicroUsd(totals, { batch, model: message.model }),
  };
}

function addInto(target: UsageTotals, add: UsageTotals): void {
  target.input_tokens += add.input_tokens;
  target.output_tokens += add.output_tokens;
  target.cache_read_tokens += add.cache_read_tokens;
  target.cache_creation_5m_tokens += add.cache_creation_5m_tokens;
  target.cache_creation_1h_tokens += add.cache_creation_1h_tokens;
  target.web_search_requests += add.web_search_requests;
  target.code_execution_seconds += add.code_execution_seconds;
}

/** Thinking share of the output, as the API reports it (absent on older responses and on errors). */
export function thinkingTokensOf(message: BetaMessage | undefined): number | null {
  const details = (message?.usage as { output_tokens_details?: { thinking_tokens?: number | null } | null } | undefined)
    ?.output_tokens_details;
  return typeof details?.thinking_tokens === "number" ? details.thinking_tokens : null;
}

export interface UsageRowInput {
  ctx: BudgetContext;
  task: { id: string; version: number };
  mode: CallMode;
  attempt: number;
  latencyMs: number;
  ttftMs: number | null;
  /** Present for a successful response, absent for transport errors. */
  message?: BetaMessage;
  batch?: { batchId: string; customId: string } | null;
  errorCode?: string | null;
}

/** One ai_usage row for one API request (§9.2). No prompt or response content. */
export function buildUsageRow(input: UsageRowInput): AiUsageRow {
  const { ctx, task, message } = input;
  const isBatch = input.mode === "batch";
  const summary = message ? summarizeMessage(message, isBatch) : null;
  const totals = summary?.totals ?? zeroUsage();
  const refusal = message?.stop_details?.category ?? null;
  return {
    user_id: ctx.userId,
    class_group_id: ctx.classGroupId,
    subject_id: ctx.subjectId ?? null,
    document_id: ctx.documentId ?? null,
    node_id: ctx.nodeId ?? null,
    job_id: ctx.jobId ?? null,
    feature: ctx.feature,
    task_id: task.id,
    prompt_version: `${task.id}@v${task.version}`,
    budget_class: ctx.budgetClass,
    mode: input.mode,
    model_requested: modelFor(task.id),
    model_served: summary?.modelServed ?? modelFor(task.id),
    fallback_used: summary?.fallbackUsed ?? false,
    effort: effortFor(task),
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    thinking_tokens: thinkingTokensOf(message),
    cache_creation_5m_tokens: totals.cache_creation_5m_tokens,
    cache_creation_1h_tokens: totals.cache_creation_1h_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    server_tool_uses:
      totals.web_search_requests > 0 || totals.code_execution_seconds > 0
        ? {
            web_search_requests: totals.web_search_requests,
            code_execution_seconds: totals.code_execution_seconds,
          }
        : null,
    stop_reason: message?.stop_reason ?? null,
    refusal_category: refusal,
    cost_micro_usd: summary?.costMicroUsd ?? 0,
    price_version: PRICE_VERSION,
    latency_ms: input.latencyMs,
    ttft_ms: input.ttftMs,
    request_id: message?.id ?? null,
    batch_id: input.batch?.batchId ?? null,
    custom_id: input.batch?.customId ?? null,
    attempt: input.attempt,
    error_code: input.errorCode ?? null,
  };
}
