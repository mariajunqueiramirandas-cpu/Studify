// The one wrapper every Edge Function and worker job uses to call Claude (ai-pipeline §2.5).
// Flow: budget reserve -> request (sync, or stream for L/XL and streamed callers) -> stop_reason
// handling (§2.4) -> Zod validation with one retry (architecture §5) -> ai_usage row per request
// -> budget settle. Runtime-neutral: the client, budget store and usage sink are injected.

import { assertRequestShape, buildParams, estimateMicroUsd } from "./request.ts";
import { requestMaxTokensClass, requiresStreaming } from "./models.ts";
import { AiError, BudgetExceededError, classifyError } from "./errors.ts";
import { buildUsageRow, summarizeMessage } from "./usage.ts";
import { extractContent, mapSpanCitations, parseStructured } from "./interpret.ts";
import { mapCitation } from "./pdf.ts";
import { createEventQueue } from "./stream.ts";
import type {
  BetaMessage,
  BetaMessageParam,
  CallMeta,
  CallMode,
  CallOptions,
  CallResult,
  ClaudeDeps,
  MappedCitation,
  RequestOpts,
  StreamEvent,
  StreamHandle,
  TaskCall,
} from "./types.ts";

/** pause_turn continuations before the step fails (ai-pipeline §2.4). */
export const MAX_PAUSE_CONTINUATIONS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

interface Hooks {
  onText(text: string): void;
  onCitation(citation: MappedCitation): void;
  onReset(): void;
}

/**
 * Calls Claude for one task and returns a classified result. Throws only for budget refusal
 * (BudgetExceededError), bugs (AiBadRequestError), configuration (AiUnavailableError) and
 * transient failures after SDK retries (AiRetryLaterError).
 */
export async function callClaude<T>(
  deps: ClaudeDeps,
  call: TaskCall<T>,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  return runTask(deps, call, options, null);
}

/**
 * Streaming variant. `events` yields text and citation events as they arrive; `result` resolves
 * with the same classified result as callClaude. On `reset`, discard text received so far (a
 * retry is starting). On `end` with status refused or invalid_output, discard the streamed text.
 */
export function streamClaude<T>(
  deps: ClaudeDeps,
  call: TaskCall<T>,
  options: CallOptions = {},
): StreamHandle<T> {
  const queue = createEventQueue<StreamEvent>();
  const hooks: Hooks = {
    onText: (text) => queue.push({ type: "text", text }),
    onCitation: (citation) => queue.push({ type: "citation", citation }),
    onReset: () => queue.push({ type: "reset" }),
  };
  const result = runTask(deps, call, options, hooks).then(
    (value) => {
      queue.push({ type: "end", status: value.status });
      queue.close();
      return value;
    },
    (error: unknown) => {
      queue.fail(error);
      throw error;
    },
  );
  // Consumers that only iterate `events` must not trigger an unhandled rejection.
  result.catch(() => undefined);
  return { events: queue.iterable, result };
}

export function promptVersion(task: { id: string; version: number }): string {
  return `${task.id}@v${task.version}`;
}

async function runTask<T>(
  deps: ClaudeDeps,
  call: TaskCall<T>,
  options: CallOptions,
  hooks: Hooks | null,
): Promise<CallResult<T>> {
  const mode: CallMode = hooks ? "stream" : "sync";
  (options.signal ?? deps.signal)?.throwIfAborted();
  const reservation = await deps.budget.reserve({
    ctx: call.ctx,
    taskId: call.task.id,
    promptVersion: promptVersion(call.task),
    estimateMicroUsd: estimateMicroUsd(call, { batch: false }),
    mode,
  });
  if (!reservation.ok) {
    throw new BudgetExceededError(reservation.scope, reservation.resetsAt);
  }
  const spend = { micro: 0 };
  try {
    return await attemptLoop(deps, call, options, hooks, mode, spend);
  } finally {
    // Settle with what was actually spent; 0 releases the reservation when no response arrived.
    await deps.budget.settle(reservation.reservationId, spend.micro);
  }
}

async function attemptLoop<T>(
  deps: ClaudeDeps,
  call: TaskCall<T>,
  options: CallOptions,
  hooks: Hooks | null,
  mode: CallMode,
  spend: { micro: number },
): Promise<CallResult<T>> {
  const clock = deps.clock ?? Date.now;
  const task = call.task;
  const sources = call.sources;
  const requestOpts: RequestOpts = {
    timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: deps.maxRetries ?? DEFAULT_MAX_RETRIES,
    ...((options.signal ?? deps.signal) ? { signal: options.signal ?? deps.signal } : {}),
  };

  // One paid request per call (pause_turn continuations aside): no truncation or validation retry.
  const cls = requestMaxTokensClass(task);
  let messages: readonly BetaMessageParam[] = call.messages;
  let continuations = 0;
  let attempt = 0;
  const requestIds: string[] = [];

  for (;;) {
    (options.signal ?? deps.signal)?.throwIfAborted();
    attempt++;
    const params = buildParams(call, { batch: false, maxTokensClass: cls, messages });
    assertRequestShape(params, { batch: false, allowAssistantTail: continuations > 0 });

    const started = clock();
    const timing = { ttftMs: null as number | null };
    const onFirstText = () => {
      if (timing.ttftMs === null) timing.ttftMs = clock() - started;
    };
    const stream = requiresStreaming(cls) || mode === "stream";

    let message: BetaMessage;
    try {
      message = await sendOnce(deps, params, requestOpts, stream, hooks, sources, onFirstText);
    } catch (err) {
      const classified = classifyError(err);
      await deps.usage.record(
        buildUsageRow({
          ctx: call.ctx,
          task,
          mode,
          attempt,
          latencyMs: clock() - started,
          ttftMs: timing.ttftMs,
          errorCode: classified instanceof AiError ? classified.code : "ai_unknown",
        }),
      );
      throw classified;
    }

    const summary = summarizeMessage(message, false);
    spend.micro += summary.costMicroUsd;
    requestIds.push(message.id);
    await deps.usage.record(
      buildUsageRow({
        ctx: call.ctx,
        task,
        mode,
        attempt,
        latencyMs: clock() - started,
        ttftMs: timing.ttftMs,
        message,
      }),
    );

    const extracted = extractContent(message.content);
    const meta = (): CallMeta => ({
      requestIds: [...requestIds],
      modelServed: message.model,
      stopReason: message.stop_reason,
      attempts: attempt,
      costMicroUsd: spend.micro,
      text: extracted.text,
      citations: mapSpanCitations(extracted.spans, sources),
      toolUses: extracted.toolUses,
      content: message.content,
    });

    // Read stop_reason before content (ai-pipeline §2.4).
    switch (message.stop_reason) {
      case "refusal":
        return { status: "refused", refusalCategory: message.stop_details?.category ?? null, ...meta() };

      case "pause_turn": {
        if (continuations >= MAX_PAUSE_CONTINUATIONS) {
          return { status: "truncated", reason: "pause_turn_limit", ...meta() };
        }
        continuations++;
        messages = [
          ...messages,
          { role: "assistant", content: message.content as unknown as NonNullable<BetaMessageParam["content"]> },
        ];
        continue;
      }

      case "max_tokens":
      case "model_context_window_exceeded": {
        // No retry (one paid request per call); prose keeps its text (TUT-01).
        return {
          status: "truncated",
          reason: message.stop_reason === "max_tokens" ? "max_tokens" : "context_window",
          ...meta(),
        };
      }

      default:
        break;
    }

    if (task.output.mode === "structured") {
      // No validation retry: limits are stated in the schema the model reads, and items that still break them are
      // dropped (salvage) so one bad item does not cost the whole call.
      const parsed = parseStructured(extracted.text, task);
      if (parsed.ok) return { status: "ok", data: parsed.data, ...(parsed.salvage ? { salvage: parsed.salvage } : {}), ...meta() };
      return { status: "invalid_output", issues: parsed.issues, ...meta() };
    }

    return { status: "ok", data: extracted.text as T, ...meta() };
  }
}

async function sendOnce(
  deps: ClaudeDeps,
  params: ReturnType<typeof buildParams>,
  opts: RequestOpts,
  stream: boolean,
  hooks: Hooks | null,
  sources: TaskCall<unknown>["sources"],
  onFirstText: () => void,
): Promise<BetaMessage> {
  if (!stream) {
    return deps.client.beta.messages.create(params, opts);
  }
  const handle = deps.client.beta.messages.stream(params, opts);
  handle.on("text", (text) => {
    onFirstText();
    hooks?.onText(text);
  });
  if (hooks) {
    handle.on("citation", (citation) => {
      hooks.onCitation(mapCitation(citation, sources));
    });
  }
  return handle.finalMessage();
}

