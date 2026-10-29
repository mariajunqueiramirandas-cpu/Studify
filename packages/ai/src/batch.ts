// Message Batches helpers (ai-pipeline §7). Submit a wave, poll, collect results keyed by custom_id.
// No fallbacks on Batch requests (§7.4): refused items can be re-run on the standard API.
// Runtime-neutral: retained for provider/domain tests; production server operations use direct standard calls
// and short scripts.

import { callClaude, promptVersion } from "./callClaude.ts";
import { AiRetryLaterError, BudgetExceededError, classifyError } from "./errors.ts";
import { buildParams, assertRequestShape, estimateMicroUsd } from "./request.ts";
import { extractContent, mapSpanCitations, parseStructured } from "./interpret.ts";
import { buildUsageRow, summarizeMessage } from "./usage.ts";
import { requestMaxTokensClass } from "./models.ts";
import type {
  BetaCreateParams,
  BetaMessageBatchIndividualResponse,
  BudgetContext,
  CallResult,
  ClaudeDeps,
  MappedCitation,
  TaskCall,
} from "./types.ts";

/** Batch limits: up to 100,000 requests (§7.2). custom_id: 1–64 of [A-Za-z0-9_-]. */
export const BATCH_MAX_REQUESTS = 100_000;
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Polls every 30 s; a batch still running after 60 min is cancelled (§7.3). */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_WAIT_MS = 60 * 60_000;

export interface BatchItem<T = any> {
  /** Short opaque id, e.g. "w12_3". Map it to the logical key in ai_batch_requests. */
  customId: string;
  call: TaskCall<T>;
}

export interface BatchSubmission {
  batchId: string;
  /** Budget reservation for the whole wave; settled by collectBatch. */
  reservationId: string;
  estimateMicroUsd: number;
  customIds: string[];
  submittedAt: string;
}

export interface BatchStatus {
  batchId: string;
  processingStatus: "in_progress" | "canceling" | "ended";
  counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}

export type BatchItemOutcome<T = unknown> =
  | { customId: string; status: "ok"; source: "batch" | "standard"; data: T; text: string; citations: MappedCitation[]; salvage?: { dropped: number; issues: string } }
  | { customId: string; status: "refused"; source: "batch" | "standard"; refusalCategory: string | null }
  /** max_tokens on a batch item: resubmit in the next wave with class XL (§7.3). */
  | { customId: string; status: "truncated"; source: "batch" | "standard"; reason: string }
  /** Off-schema after Zod and postValidate. Retry in the next wave, then failed. */
  | { customId: string; status: "invalid_output"; source: "batch" | "standard"; issues: string }
  /** invalid_request is a bug (retryable false). Other errors are retried in the next wave. */
  | { customId: string; status: "errored"; errorType: string; message: string; retryable: boolean }
  /** Resubmit on the standard API (§7.3). */
  | { customId: string; status: "canceled" | "expired" | "missing" };

export interface BatchCollectResult {
  outcomes: BatchItemOutcome[];
  /** Sum of ai_usage costs written for this wave (batch discount applied). */
  batchCostMicroUsd: number;
}

/** Builds one Batch request. Same prompt and params as the standard path, minus fallbacks and betas (§7.4). */
export function buildBatchRequest(item: BatchItem): { custom_id: string; params: BetaCreateParams } {
  assertCustomId(item.customId);
  const params = buildParams(item.call, {
    batch: true,
    maxTokensClass: requestMaxTokensClass(item.call.task),
    messages: item.call.messages,
  });
  assertRequestShape(params, { batch: true });
  return { custom_id: item.customId, params };
}

function assertCustomId(customId: string): void {
  if (!CUSTOM_ID_PATTERN.test(customId)) {
    throw new Error(`custom_id must match ${CUSTOM_ID_PATTERN.source}: "${customId}"`);
  }
}

/**
 * Reserves the whole wave in the budget, then creates the batch. If creation fails the
 * reservation is released.
 */
export async function submitBatch(
  deps: ClaudeDeps,
  input: { ctx: BudgetContext; items: readonly BatchItem[] },
): Promise<BatchSubmission> {
  const { items } = input;
  if (items.length === 0) throw new Error("submitBatch needs at least one item");
  if (items.length > BATCH_MAX_REQUESTS) throw new Error(`a batch holds at most ${BATCH_MAX_REQUESTS} requests`);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.customId)) throw new Error(`duplicate custom_id ${item.customId}`);
    seen.add(item.customId);
  }
  const requests = items.map(buildBatchRequest);
  const estimate = items.reduce((sum, item) => sum + estimateMicroUsd(item.call, { batch: true }), 0);
  const first = items[0]?.call.task;
  if (!first) throw new Error("submitBatch needs at least one item");

  const reservation = await deps.budget.reserve({
    ctx: input.ctx,
    taskId: first.id,
    promptVersion: promptVersion(first),
    estimateMicroUsd: estimate,
    mode: "batch",
  });
  if (!reservation.ok) throw new BudgetExceededError(reservation.scope, reservation.resetsAt);

  const clock = deps.clock ?? Date.now;
  let batchId: string;
  try {
    const created = await deps.client.beta.messages.batches.create({ requests });
    batchId = created.id;
  } catch (err) {
    await deps.budget.settle(reservation.reservationId, 0);
    throw classifyError(err);
  }
  return {
    batchId,
    reservationId: reservation.reservationId,
    estimateMicroUsd: estimate,
    customIds: items.map((i) => i.customId),
    submittedAt: new Date(clock()).toISOString(),
  };
}

/** One poll: GET the batch. Call from a scheduled job every 30 s until status is "ended". */
export async function pollBatch(deps: ClaudeDeps, batchId: string): Promise<BatchStatus> {
  const batch = await deps.client.beta.messages.batches.retrieve(batchId);
  return {
    batchId,
    processingStatus: batch.processing_status,
    counts: {
      processing: batch.request_counts.processing,
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
    },
  };
}

export interface WaitOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls until the batch ends. After maxWaitMs (60 min) it cancels the batch and waits for the
 * cancellation to finish. Unfinished items then come back as canceled and are re-run on the
 * standard API by the caller (§7.3).
 */
export async function waitForBatch(
  deps: ClaudeDeps,
  batchId: string,
  opts: WaitOptions = {},
): Promise<{ status: "ended"; cancelledByTimeout: boolean }> {
  const clock = deps.clock ?? Date.now;
  const sleep = opts.sleep ?? deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const started = clock();
  let cancelled = false;
  for (;;) {
    const status = await pollBatch(deps, batchId);
    if (status.processingStatus === "ended") return { status: "ended", cancelledByTimeout: cancelled };
    if (!cancelled && clock() - started >= maxWaitMs) {
      await deps.client.beta.messages.batches.cancel(batchId);
      cancelled = true;
    }
    await sleep(intervalMs);
  }
}

/**
 * Reads results once the batch has ended. Results arrive in any order, so every item is looked up
 * by custom_id. Each succeeded response writes one ai_usage row (mode batch). The wave reservation
 * is settled with the sum of those costs. Refused items are re-run on the standard API when
 * rerunRefused is set (§7.3); those re-runs have their own budget reservations.
 */
export async function collectBatch(
  deps: ClaudeDeps,
  submission: BatchSubmission,
  items: readonly BatchItem[],
  opts: { rerunRefused?: boolean } = {},
): Promise<BatchCollectResult> {
  const batch = await deps.client.beta.messages.batches.retrieve(submission.batchId);
  if (batch.processing_status !== "ended") {
    throw new AiRetryLaterError(`batch ${submission.batchId} is still ${batch.processing_status}`);
  }

  const results = new Map<string, BetaMessageBatchIndividualResponse["result"]>();
  const rows = await deps.client.beta.messages.batches.results(submission.batchId);
  for await (const row of rows) {
    results.set(row.custom_id, row.result);
  }

  let batchCost = 0;
  const outcomes: BatchItemOutcome[] = [];
  try {
    for (const item of items) {
      const outcome = await collectOne(deps, submission, item, results.get(item.customId), opts, (micro) => {
        batchCost += micro;
      });
      outcomes.push(outcome);
    }
  } finally {
    await deps.budget.settle(submission.reservationId, batchCost);
  }
  return { outcomes, batchCostMicroUsd: batchCost };
}

async function collectOne(
  deps: ClaudeDeps,
  submission: BatchSubmission,
  item: BatchItem,
  result: BetaMessageBatchIndividualResponse["result"] | undefined,
  opts: { rerunRefused?: boolean },
  addCost: (micro: number) => void,
): Promise<BatchItemOutcome> {
  const { customId, call } = item;
  if (!result) return { customId, status: "missing" };

  switch (result.type) {
    case "succeeded": {
      const message = result.message;
      const summary = summarizeMessage(message, true);
      addCost(summary.costMicroUsd);
      await deps.usage.record(
        buildUsageRow({
          ctx: call.ctx,
          task: call.task,
          mode: "batch",
          attempt: 1,
          latencyMs: 0,
          ttftMs: null,
          message,
          batch: { batchId: submission.batchId, customId },
        }),
      );

      if (message.stop_reason === "refusal") {
        if (opts.rerunRefused) {
          const rerun = await callClaude(deps, call);
          return fromCallResult(customId, rerun, "standard");
        }
        return { customId, status: "refused", source: "batch", refusalCategory: message.stop_details?.category ?? null };
      }
      if (message.stop_reason === "max_tokens") {
        return { customId, status: "truncated", source: "batch", reason: "max_tokens" };
      }

      const extracted = extractContent(message.content);
      const citations = mapSpanCitations(extracted.spans, call.sources);
      if (call.task.output.mode === "structured") {
        const parsed = parseStructured(extracted.text, call.task);
        if (!parsed.ok) return { customId, status: "invalid_output", source: "batch", issues: parsed.issues };
        return { customId, status: "ok", source: "batch", data: parsed.data, text: extracted.text, citations, ...(parsed.salvage ? { salvage: parsed.salvage } : {}) };
      }
      return { customId, status: "ok", source: "batch", data: extracted.text, text: extracted.text, citations };
    }
    case "errored": {
      const error = result.error.error;
      return {
        customId,
        status: "errored",
        errorType: error.type,
        message: error.message,
        retryable: error.type !== "invalid_request_error",
      };
    }
    case "canceled":
      return { customId, status: "canceled" };
    case "expired":
      return { customId, status: "expired" };
    default:
      return { customId, status: "missing" };
  }
}

function fromCallResult(customId: string, result: CallResult<unknown>, source: "standard"): BatchItemOutcome {
  switch (result.status) {
    case "ok":
      return { customId, status: "ok", source, data: result.data, text: result.text, citations: result.citations };
    case "refused":
      return { customId, status: "refused", source, refusalCategory: result.refusalCategory };
    case "truncated":
      return { customId, status: "truncated", source, reason: result.reason };
    case "invalid_output":
      return { customId, status: "invalid_output", source, issues: result.issues };
  }
}
