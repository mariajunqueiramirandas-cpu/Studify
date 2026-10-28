// Builds Messages API request params from a TaskCall, enforces the request rules of ai-pipeline §2.2
// and §6.2 as runtime invariants, and estimates budget cost. Runtime-neutral.

import { z } from "zod";
import {
  DEFAULT_OUTPUT_TOKENS,
  DEFAULT_TOKENS_PER_PAGE,
  MAX_TOKENS,
  costMicroUsd,
  effortFor,
  hasServerFallback,
  modelFor,
  syncRequestDefaults,
  zeroUsage,
} from "./models.ts";
import { AiBadRequestError } from "./errors.ts";
import type {
  BetaCreateParams,
  BetaMessageParam,
  BetaTextBlockParam,
  ChoiceKind,
  Choices,
  MaxTokensClass,
  SourceMap,
  SystemBlock,
  TaskCall,
  UsageTotals,
} from "./types.ts";

/** Sampling and thinking params are rejected by the API on the default model (ai-pipeline §2.2). */
const FORBIDDEN_PARAMS = ["temperature", "top_p", "top_k", "thinking", "stop_sequences"] as const;

/**
 * Choices from the pages a prompt sent (document label → original pages): the labels, and every page sent. A page
 * of one document cited under another label still passes the enum; the page checks after the call catch that.
 */
export function choicesFromPages(pagesByLabel: Readonly<Record<string, readonly number[]>> | undefined): Choices {
  const labels = Object.keys(pagesByLabel ?? {});
  if (labels.length === 0) return {};
  const pages = [...new Set(labels.flatMap((l) => pagesByLabel![l] ?? []))];
  return pages.length > 0 ? { doc: labels, page: pages } : { doc: labels };
}

/** Schema marker (packages/prompts common.ts) for values limited to what the prompt showed; see TaskCall.choices. */
const CHOICE_KEYWORD = "x-choice";

/** Keywords the API does not enforce for structured outputs. Zod still enforces them (§5.1). */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$schema",
]);

/**
 * Zod schema to the JSON schema sent as output_config.format, with additionalProperties: false. The API rejects or
 * ignores length, count and range keywords, so each one is removed and restated in the node's description: the model
 * reads the limit there and writes within it on the first attempt, instead of failing Zod after the fact.
 */
export function toJsonSchema(schema: z.ZodType, choices: Choices = {}): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  return stripSchema(raw, choices) as Record<string, unknown>;
}

function stripSchema(node: unknown, choices: Choices): unknown {
  if (Array.isArray(node)) return node.map((child) => stripSchema(child, choices));
  if (!node || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  // A value that must be one the prompt showed: an enum of this call's values (decoding allows nothing else).
  const kind = source[CHOICE_KEYWORD] as ChoiceKind | undefined;
  const allowed = kind ? choices[kind] : undefined;
  if (allowed && allowed.length > 0) {
    const values = [...new Set(allowed)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { type: source.type, enum: values, ...(typeof source.description === "string" ? { description: source.description } : {}) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key) || key === CHOICE_KEYWORD) continue;
    out[key] = stripSchema(value, choices);
  }
  const limits = describeLimits(source);
  if (limits) {
    out.description = typeof out.description === "string" && out.description ? `${out.description} (${limits})` : limits;
  }
  if (out.type === "object" && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/** A usable bound: Zod's safe-integer bounds on every int say nothing, so they are left out. */
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : null;

function range(min: number | null, max: number | null, unit: string): string | null {
  if (min !== null && max !== null) return min === max ? `exatamente ${min} ${unit}` : `de ${min} a ${max} ${unit}`;
  if (max !== null) return `até ${max} ${unit}`;
  if (min !== null && min > 1) return `pelo menos ${min} ${unit}`;
  return null;
}

/** The removed keywords of one node, as the text the model reads ("até 300 caracteres", "de 3 a 8 itens"…). */
export function describeLimits(node: Record<string, unknown>): string | null {
  const parts: string[] = [];
  // A string's min of 1 only says "not empty", which every field is.
  const minLength = num(node.minLength);
  const text = range(minLength !== null && minLength > 1 ? minLength : null, num(node.maxLength), "caracteres");
  if (text) parts.push(text);
  const items = range(num(node.minItems), num(node.maxItems), "itens");
  if (items) parts.push(items);
  if (node.uniqueItems === true) parts.push("sem itens repetidos");
  const lo = num(node.minimum) ?? num(node.exclusiveMinimum);
  const hi = num(node.maximum) ?? num(node.exclusiveMaximum);
  const loText = num(node.minimum) !== null ? `>= ${lo}` : lo !== null ? `> ${lo}` : null;
  const hiText = num(node.maximum) !== null ? `<= ${hi}` : hi !== null ? `< ${hi}` : null;
  if (loText && hiText) parts.push(`valor ${loText} e ${hiText}`);
  else if (loText) parts.push(`valor ${loText}`);
  else if (hiText) parts.push(`valor ${hiText}`);
  if (num(node.multipleOf) !== null) parts.push(`múltiplo de ${node.multipleOf}`);
  return parts.length ? parts.join("; ") : null;
}

export function buildSystem(system: readonly SystemBlock[]): BetaTextBlockParam[] {
  return system.map((block) => {
    const param: BetaTextBlockParam = { type: "text", text: block.text };
    if (block.cacheTtl) param.cache_control = { type: "ephemeral", ttl: block.cacheTtl };
    return param;
  });
}

export interface BuildParamsOptions {
  batch: boolean;
  maxTokensClass: MaxTokensClass;
  messages: readonly BetaMessageParam[];
}

/**
 * Request params for one attempt. Effort comes from the owner policy (effortFor), not from
 * task.effort. Synchronous requests get the server-side refusal fallback only on models that
 * have one (syncRequestDefaults); Batch requests never do (§7.4). Thinking is omitted: adaptive
 * only on Haiku 5.5.
 */
export function buildParams<T>(call: TaskCall<T>, opts: BuildParamsOptions): BetaCreateParams {
  const { task } = call;
  const format =
    task.output.mode === "structured"
      ? { type: "json_schema" as const, schema: toJsonSchema(task.output.schema, call.choices) }
      : undefined;
  const model = modelFor(task.id);
  const params: BetaCreateParams = {
    model,
    max_tokens: MAX_TOKENS[opts.maxTokensClass],
    output_config: {
      effort: effortFor(task),
      ...(format ? { format } : {}),
    },
    system: buildSystem(call.system),
    messages: [...opts.messages],
  };
  if (call.tools && call.tools.length > 0) {
    params.tools = call.tools;
    params.tool_choice = { type: "auto" };
  }
  return opts.batch ? params : { ...params, ...syncRequestDefaults(model) };
}

export interface ShapeOptions {
  batch: boolean;
  /** True for pause_turn continuations, which legitimately end with an assistant turn. */
  allowAssistantTail?: boolean;
}

/**
 * Throws AiBadRequestError (a bug, never retried) when a request breaks the rules of ai-pipeline
 * §2.2, §5.2, §6.2 and §6.6 for the default model. Runs before every API call.
 */
export function assertRequestShape(params: BetaCreateParams, opts: ShapeOptions): void {
  const bag = params as unknown as Record<string, unknown>;
  const model = String(params.model);
  for (const key of FORBIDDEN_PARAMS) {
    if (key in bag) fail(`${key} is not allowed on ${model} (ai-pipeline §2.2)`);
  }
  if (opts.batch && ("fallbacks" in bag || "betas" in bag)) {
    fail("fallbacks and betas are rejected on the Batches API (ai-pipeline §7.4)");
  }
  if (!opts.batch && !hasServerFallback(model) && ("fallbacks" in bag || "betas" in bag)) {
    fail(`fallbacks and betas are not accepted on ${model}: it has no server-side fallback (ai-pipeline §2.2)`);
  }
  const choice = params.tool_choice as { type?: string } | undefined;
  if (choice && (choice.type === "any" || choice.type === "tool")) {
    fail(`forced tool_choice (any/tool) is not allowed on ${model}: it skips thinking (ai-pipeline §2.2)`);
  }

  const messages = params.messages;
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && !opts.allowAssistantTail) {
    fail("messages must not end with an assistant turn (prefill returns 400)");
  }

  let anyCitedDocument = false;
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [] : message.content;
    let seenText = false;
    for (const block of blocks as Array<{ type: string; citations?: unknown; cache_control?: unknown }>) {
      if (block.type === "document") {
        if (message.role === "assistant") fail("document blocks are not allowed in assistant turns");
        if (seenText) fail("document and image blocks must precede text in a user turn (ai-pipeline §2.2)");
        if ((block as { citations?: { enabled?: boolean } }).citations?.enabled) anyCitedDocument = true;
      }
      if (block.type === "image" && seenText) {
        fail("document and image blocks must precede text in a user turn (ai-pipeline §2.2)");
      }
      if (block.type === "text") {
        seenText = true;
        if (message.role === "user" && block.citations) {
          fail("text blocks with citations are not allowed in user turns (API 2026-10-21, ai-pipeline §2.2)");
        }
      }
    }
  }

  const format = (params.output_config as { format?: unknown } | undefined)?.format;
  if (format && anyCitedDocument) {
    fail("citations and output_config.format cannot be combined in one request (ai-pipeline §5)");
  }

  // Cache breakpoints: at most 4, and longer TTLs before shorter ones (ai-pipeline §6.2).
  const ttls: string[] = [];
  for (const block of params.system as Array<{ cache_control?: { ttl?: string } }>) {
    if (block.cache_control) ttls.push(block.cache_control.ttl ?? "5m");
  }
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content as Array<{ cache_control?: { ttl?: string } }>) {
      if (block.cache_control) ttls.push(block.cache_control.ttl ?? "5m");
    }
  }
  if (ttls.length > 4) fail(`at most 4 cache breakpoints per request, got ${ttls.length}`);
  const firstShort = ttls.indexOf("5m");
  if (firstShort >= 0 && ttls.indexOf("1h", firstShort) >= 0) {
    fail("1h cache breakpoints must come before 5m ones in the prefix (ai-pipeline §6.2)");
  }
}

function fail(message: string): never {
  throw new AiBadRequestError(message, { status: 400 });
}

/** Rough token count for text (about 3 characters per token; PT-BR is close to English here). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Input tokens for the budget reservation: explicit estimate, else text + slice token counts. */
export function estimateInputTokens<T>(call: TaskCall<T>): number {
  if (call.estimate?.inputTokens !== undefined) return call.estimate.inputTokens;
  let tokens = 0;
  for (const block of call.system) tokens += approxTokens(block.text);
  let docIndex = 0;
  const sources: SourceMap = call.sources ?? [];
  for (const message of call.messages) {
    if (typeof message.content === "string") {
      tokens += approxTokens(message.content);
      continue;
    }
    for (const block of message.content as Array<{ type: string; text?: string }>) {
      if (block.type === "text" && block.text) tokens += approxTokens(block.text);
      if (block.type === "document") {
        const slice = sources[docIndex];
        tokens += slice?.tokenCount ?? (slice ? slice.pages.length : 1) * DEFAULT_TOKENS_PER_PAGE;
        docIndex++;
      }
      if (block.type === "image") tokens += 1_600;
    }
  }
  return tokens;
}

/** Budget estimate in micro-USD for one call (ai-pipeline §9.1). */
export function estimateMicroUsd<T>(call: TaskCall<T>, opts: { batch: boolean }): number {
  const usage: UsageTotals = {
    ...zeroUsage(),
    input_tokens: estimateInputTokens(call),
    output_tokens: call.estimate?.outputTokens ?? DEFAULT_OUTPUT_TOKENS[call.task.maxTokensClass],
  };
  return costMicroUsd(usage, { batch: opts.batch, model: modelFor(call.task.id) });
}
