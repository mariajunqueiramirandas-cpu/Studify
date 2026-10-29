// Shared types for the Claude wrapper. Runtime-neutral: type-only imports from the SDK and zod.
// Local mirrors of the Postgres rows we need (document_slices, ai_usage) live here on purpose:
// packages/ai must not depend on packages/shared while that package is still being written.

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
export type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
export type BetaTextCitation = Anthropic.Beta.Messages.BetaTextCitation;
export type BetaUsage = Anthropic.Beta.Messages.BetaUsage;
export type BetaRequestDocumentBlock = Anthropic.Beta.Messages.BetaRequestDocumentBlock;
export type BetaMessageBatch = Anthropic.Beta.Messages.Batches.BetaMessageBatch;
export type BetaMessageBatchIndividualResponse = Anthropic.Beta.Messages.Batches.BetaMessageBatchIndividualResponse;
export type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type BetaBatchCreateParams = Anthropic.Beta.Messages.Batches.BatchCreateParams;

/** Effort per task (ai-pipeline §2.2). Always set explicitly. */
export type Effort = "low" | "medium" | "high";

/** max_tokens classes (ai-pipeline §2.3). */
export type MaxTokensClass = "XS" | "S" | "M" | "L" | "XL";

/** Budget classes (ai-pipeline §9.1). */
export type BudgetClass = "content" | "user" | "system";

/** How a call reached the API. */
export type CallMode = "sync" | "stream" | "batch";

export type CacheTtl = "5m" | "1h";

// ---------------------------------------------------------------------------
// Task definitions (packages/prompts will provide these; defined locally here)
// ---------------------------------------------------------------------------

export type TaskOutput<T> =
  /** Structured output: JSON schema sent to the API, Zod validation always runs. */
  | { mode: "structured"; schema: z.ZodType<T> }
  /** Prose with the Citations API: document blocks must have citations enabled. Result data is the text. */
  | { mode: "citations" }
  /** Plain prose, no citations. Result data is the text. */
  | { mode: "plain" };

export interface TaskDef<T = unknown> {
  /** Task id, e.g. "cards.generate". */
  id: string;
  /** Bumped on any prompt or schema change; stored as prompt_version. */
  version: number;
  /** PRD feature ids, e.g. ["MEM-01.1"]. Informational here. */
  features: readonly string[];
  effort: Effort;
  maxTokensClass: MaxTokensClass;
  output: TaskOutput<T>;
  /**
   * Extra semantic check after Zod (e.g. "cards must cite pages inside the slice").
   * Return an error message to treat the output as invalid (one retry, then invalid_output).
   */
  postValidate?: (data: T) => string | null;
}

export interface SystemBlock {
  text: string;
  /** Adds a cache breakpoint at this block (ai-pipeline §6). */
  cacheTtl?: CacheTtl;
}

/** One document (a PDF slice) as the model sees it: order matters for citation mapping. */
export interface DocumentSlice {
  /** document_slices.id */
  id: string;
  documentId: string;
  /** Document title used in the label: "Documento {title} — páginas originais {list}". */
  title: string;
  /** Ordered original page numbers, e.g. [12, 13, 14, 40, 41]. Index 0 is slice page 1. */
  pages: number[];
  /** Measured once with countTokens; used for budget estimates. */
  tokenCount?: number | null;
  /** Base64 PDF bytes for synchronous calls. */
  base64?: string;
  /** Files API id for worker jobs (ephemeral, see files.ts). */
  anthropicFileId?: string | null;
}

/**
 * Document blocks of a request, in the order they appear in `messages`.
 * Index i is the `document_index` the API reports in citations.
 */
export type SourceMap = DocumentSlice[];

/** A contiguous page range in original page numbers (SourcePage-like, TRU-01). */
export interface SourcePageRef {
  documentId: string;
  pageStart: number;
  pageEnd: number;
}

// ---------------------------------------------------------------------------
// Budget and usage (injected by callers; no DB code here)
// ---------------------------------------------------------------------------

export type BudgetScope = "user_day" | "class_group_month" | "global_month";

export interface BudgetContext {
  /** Null for system jobs. */
  userId: string | null;
  classGroupId: string | null;
  subjectId?: string | null;
  documentId?: string | null;
  nodeId?: string | null;
  jobId?: string | null;
  /** PRD feature id, e.g. "MEM-01". */
  feature: string;
  budgetClass: BudgetClass;
}

export interface BudgetReserveInput {
  ctx: BudgetContext;
  taskId: string;
  promptVersion: string;
  estimateMicroUsd: number;
  mode: CallMode;
}

export type BudgetReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; scope: BudgetScope; resetsAt?: string };

/**
 * Implemented by the caller (Edge Function or worker) on top of
 * private.ai_budget_reserve / ai_budget_settle (security-privacy §7).
 * `reserve` must be atomic. `settle` with actualMicroUsd = 0 releases the whole reservation.
 */
export interface BudgetStore {
  reserve(input: BudgetReserveInput): Promise<BudgetReserveResult>;
  settle(reservationId: string, actualMicroUsd: number): Promise<void>;
}

/** One ai_usage row (ai-pipeline §9.2). Snake_case to match the table. No prompt or response content. */
export interface AiUsageRow {
  user_id: string | null;
  class_group_id: string | null;
  subject_id: string | null;
  document_id: string | null;
  node_id: string | null;
  job_id: string | null;
  feature: string;
  task_id: string;
  prompt_version: string;
  budget_class: BudgetClass;
  mode: CallMode;
  model_requested: string;
  model_served: string;
  fallback_used: boolean;
  effort: Effort;
  input_tokens: number;
  output_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_tokens: number;
  server_tool_uses: { web_search_requests: number; code_execution_seconds: number } | null;
  stop_reason: string | null;
  refusal_category: string | null;
  cost_micro_usd: number;
  price_version: string;
  latency_ms: number;
  ttft_ms: number | null;
  /** Message id from the response (the SDK request id is not exposed through AnthropicLike). */
  request_id: string | null;
  batch_id: string | null;
  custom_id: string | null;
  /** 1-based API attempt within one callClaude invocation (validation or max_tokens retries). */
  attempt: number;
  error_code: string | null;
}

/** Implemented by the caller: writes one row per API request. */
export interface UsageSink {
  record(row: AiUsageRow): Promise<void>;
}

/** Normalized token counts for pricing. */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  web_search_requests: number;
  code_execution_seconds: number;
}

// ---------------------------------------------------------------------------
// The injectable client. Real `Anthropic` satisfies this; tests pass fakes.
// ---------------------------------------------------------------------------

export interface RequestOpts {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface MessageStreamLike {
  on(event: "text", listener: (text: string) => void): unknown;
  on(event: "citation", listener: (citation: BetaTextCitation) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}

export interface AnthropicLike {
  beta: {
    messages: {
      create(params: BetaCreateParams, options?: RequestOpts): Promise<BetaMessage>;
      stream(params: BetaCreateParams, options?: RequestOpts): MessageStreamLike;
      batches: {
        create(params: BetaBatchCreateParams, options?: RequestOpts): Promise<BetaMessageBatch>;
        retrieve(id: string, params?: unknown, options?: RequestOpts): Promise<BetaMessageBatch>;
        cancel(id: string, params?: unknown, options?: RequestOpts): Promise<BetaMessageBatch>;
        results(
          id: string,
          params?: unknown,
          options?: RequestOpts,
        ): Promise<AsyncIterable<BetaMessageBatchIndividualResponse>>;
      };
    };
  };
  files: {
    upload(params: { file: File }, options?: RequestOpts): Promise<{ id: string }>;
    delete(id: string, params?: unknown, options?: RequestOpts): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Calls and results
// ---------------------------------------------------------------------------

export interface TaskCall<T = unknown> {
  task: TaskDef<T>;
  ctx: BudgetContext;
  system: SystemBlock[];
  messages: BetaMessageParam[];
  tools?: BetaToolUnion[];
  /** Document blocks of `messages` in order. Needed for citation mapping and budget estimates. */
  sources?: SourceMap;
  /** Optional overrides for the budget estimate (e.g. known slice token counts). */
  estimate?: { inputTokens?: number; outputTokens?: number };
  /**
   * The only values the output may use for each `x-choice` kind of the schema (concept keys shown, document labels
   * and pages sent…). They are sent as JSON-schema enums, so constrained decoding rules everything else out.
   */
  choices?: Choices;
}

export type ChoiceKind = "concept" | "node" | "doc" | "page" | "topic" | "exam";
export type Choices = Partial<Record<ChoiceKind, ReadonlyArray<string | number>>>;

export interface ClaudeDeps {
  /** Operation cancellation/deadline, inherited by every model call. */
  signal?: AbortSignal;
  client: AnthropicLike;
  budget: BudgetStore;
  usage: UsageSink;
  /** Epoch milliseconds. Defaults to Date.now. */
  clock?: () => number;
  /** Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt. Defaults to 120 s (Edge Function). Worker passes 600 s. */
  timeoutMs?: number;
  /** SDK-level retries for 408/409/429/5xx/connection errors. Defaults to 2. */
  maxRetries?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** Citation with page numbers mapped back to the original PDF (ai-pipeline §4.3). */
export interface MappedCitation {
  type: string;
  citedText: string;
  documentIndex: number;
  documentId: string | null;
  /** Original page numbers. Null when the citation is not a page location or cannot be mapped. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Offsets of the text block this citation is attached to, in the concatenated text. */
  textStart: number | null;
  textEnd: number | null;
  /** True only for page locations that map inside the slice. */
  valid: boolean;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface CallMeta {
  /** Message ids of every API request made (more than one after a retry). */
  requestIds: string[];
  modelServed: string;
  stopReason: string | null;
  attempts: number;
  costMicroUsd: number;
  text: string;
  citations: MappedCitation[];
  toolUses: ToolUse[];
  /** Raw content blocks of the last response. Store these as raw_content for threads (ai-pipeline §6.6). */
  content: BetaContentBlock[];
}

export type CallResult<T> =
  /** `salvage`: list items dropped because they broke the schema on their own; the rest of the output is `data`. */
  | (CallMeta & { status: "ok"; data: T; salvage?: { dropped: number; issues: string } })
  | (CallMeta & { status: "refused"; refusalCategory: string | null })
  | (CallMeta & { status: "truncated"; reason: "max_tokens" | "context_window" | "pause_turn_limit" })
  | (CallMeta & { status: "invalid_output"; issues: string });

export type CallStatus = CallResult<unknown>["status"];

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "citation"; citation: MappedCitation }
  /** A retry is starting: discard the text received so far. */
  | { type: "reset" }
  /** Last event. `status` tells the consumer whether to keep the streamed text. */
  | { type: "end"; status: CallStatus };

export interface StreamHandle<T> {
  events: AsyncIterable<StreamEvent>;
  result: Promise<CallResult<T>>;
}
