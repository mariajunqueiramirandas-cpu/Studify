// Public API of @studify/ai. Runtime-neutral: safe to load from the worker (Node) and from Edge
// Functions (Deno). The mock server is NOT exported here; import it from "./mock/index.ts" in tests.

// Client wrapper
export { callClaude, streamClaude, promptVersion, MAX_PAUSE_CONTINUATIONS } from "./callClaude.ts";

// Batch (ai-pipeline §7)
export {
  submitBatch,
  pollBatch,
  waitForBatch,
  collectBatch,
  buildBatchRequest,
  BATCH_MAX_REQUESTS,
  CUSTOM_ID_PATTERN,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "./batch.ts";

// Files API (ai-pipeline §4.2)
export {
  uploadSliceFile,
  deleteFile,
  deleteDocumentFiles,
  sweepExpiredFiles,
  isFileExpired,
  FILE_RETENTION_MS,
} from "./files.ts";

// PDF slices, page numbers and citations (ai-pipeline §4.1, §4.3, §5.2)
export {
  documentBlocks,
  documentLabel,
  formatPageList,
  pagesToRanges,
  toOriginalPage,
  mapSourcePages,
  mapCitation,
  imageBlock,
} from "./pdf.ts";

// Request building, invariants and estimates (ai-pipeline §2.2, §6.2, §9.1)
export {
  buildParams,
  assertRequestShape,
  toJsonSchema,
  estimateMicroUsd,
  estimateInputTokens,
} from "./request.ts";

// Model policy, request defaults, max_tokens classes, prices and cost (ai-pipeline §2.1–§2.3, §9.3)
export {
  DEFAULT_MODEL,
  MODEL_OVERRIDES,
  modelFor,
  SERVER_FALLBACK_BETA,
  SYNC_REQUEST_DEFAULTS,
  API_VERSION,
  MAX_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_PAGE,
  nextMaxTokensClass,
  requiresStreaming,
  PRICE_VERSION,
  PRICES,
  SERVER_TOOL_PRICES,
  BATCH_DISCOUNT,
  priceFor,
  costUsd,
  costMicroUsd,
  zeroUsage,
} from "./models.ts";

// Usage rows and per-response cost (ai-pipeline §9.2)
export { buildUsageRow, summarizeMessage, totalsFromUsage } from "./usage.ts";

// Response interpretation (ai-pipeline §2.4, §5.1)
export { extractContent, parseStructured, mapSpanCitations } from "./interpret.ts";

// Errors (ai-pipeline §10.1)
export {
  AiError,
  BudgetExceededError,
  AiBadRequestError,
  AiUnavailableError,
  AiRetryLaterError,
  classifyError,
} from "./errors.ts";

// Types
export type {
  Effort,
  MaxTokensClass,
  BudgetClass,
  CallMode,
  CacheTtl,
  TaskDef,
  TaskOutput,
  SystemBlock,
  TaskCall,
  DocumentSlice,
  SourceMap,
  SourcePageRef,
  BudgetContext,
  BudgetScope,
  BudgetStore,
  BudgetReserveInput,
  BudgetReserveResult,
  UsageSink,
  AiUsageRow,
  UsageTotals,
  AnthropicLike,
  MessageStreamLike,
  RequestOpts,
  ClaudeDeps,
  CallOptions,
  CallResult,
  CallMeta,
  CallStatus,
  StreamEvent,
  StreamHandle,
  MappedCitation,
  ToolUse,
} from "./types.ts";
export type { BatchItem, BatchSubmission, BatchStatus, BatchItemOutcome, BatchCollectResult, WaitOptions } from "./batch.ts";
export type { FileRecord, UploadedSliceFile, SweepResult, DeleteOutcome } from "./files.ts";
export type { DocumentBlockOptions, DocumentBlocks, PageRange, SourcePagesResult } from "./pdf.ts";
export type { TextSpan, ExtractedContent, ParseResult } from "./interpret.ts";
export type { UsageRowInput, MessageSummary } from "./usage.ts";
export type { ModelPrice } from "./models.ts";
export type { BuildParamsOptions, ShapeOptions } from "./request.ts";
