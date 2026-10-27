// Mock response model and the JSON / SSE encoders. Pure: no node APIs, so tests and the
// mock server share one definition of the Messages API shapes Studify uses.

export interface MockCitation {
  /** Slice-relative page numbers, exactly as the API reports them (1-based within the document block). */
  document_index: number;
  start_page_number: number;
  end_page_number: number;
  cited_text: string;
}

export interface MockTextBlock {
  type: "text";
  text: string;
  citations?: MockCitation[];
}

export interface MockThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface MockToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type MockBlock = MockTextBlock | MockThinkingBlock | MockToolUseBlock;

export type MockStopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "tool_use"
  | "pause_turn"
  | "stop_sequence"
  | "model_context_window_exceeded";

export interface MockMessage {
  id?: string;
  model?: string;
  /** Shorthand for a single text block. Ignored when `content` is set. */
  text?: string;
  content?: MockBlock[];
  stop_reason?: MockStopReason;
  refusal_category?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_5m_tokens?: number;
    cache_creation_1h_tokens?: number;
    cache_read_input_tokens?: number;
    web_search_requests?: number;
  };
}

export type MockResponse =
  /** A message. Sent as JSON, or as SSE when the request asked for `stream: true`. */
  | { kind: "message"; message: MockMessage }
  /** An HTTP error with the Anthropic error envelope. */
  | { kind: "error"; status: number; errorType?: string; message?: string; retryAfterSeconds?: number }
  /** Batch-only: result types other than succeeded. */
  | { kind: "canceled" }
  | { kind: "expired" };

export interface EncodeOptions {
  id: string;
  requestModel: string;
  /** Characters per text_delta event. */
  chunkChars?: number;
}

interface ResolvedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  server_tool_use: { web_search_requests: number; web_fetch_requests: number } | null;
}

export function resolveUsage(message: MockMessage): ResolvedUsage {
  const u = message.usage ?? {};
  const fiveMin = u.cache_creation_5m_tokens ?? 0;
  const oneHour = u.cache_creation_1h_tokens ?? 0;
  return {
    input_tokens: u.input_tokens ?? 100,
    output_tokens: u.output_tokens ?? 50,
    cache_creation_input_tokens: fiveMin + oneHour,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation: { ephemeral_5m_input_tokens: fiveMin, ephemeral_1h_input_tokens: oneHour },
    server_tool_use:
      u.web_search_requests !== undefined
        ? { web_search_requests: u.web_search_requests, web_fetch_requests: 0 }
        : null,
  };
}

export function blocksOf(message: MockMessage): MockBlock[] {
  if (message.content) return message.content;
  return [{ type: "text", text: message.text ?? "" }];
}

function citationJson(c: MockCitation) {
  return {
    type: "page_location" as const,
    cited_text: c.cited_text,
    document_index: c.document_index,
    document_title: null,
    start_page_number: c.start_page_number,
    end_page_number: c.end_page_number,
    file_id: null,
  };
}

function stopDetails(message: MockMessage): { type: "refusal"; category: string | null; explanation: null } | null {
  if (message.stop_reason !== "refusal") return null;
  return { type: "refusal", category: message.refusal_category ?? "general_harms", explanation: null };
}

/** Non-streaming Message JSON. */
export function messageJson(message: MockMessage, opts: EncodeOptions): Record<string, unknown> {
  const usage = resolveUsage(message);
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: message.model ?? opts.requestModel,
    container: null,
    context_management: null,
    content: blocksOf(message).map((b) => {
      if (b.type === "text") {
        return {
          type: "text",
          text: b.text,
          citations: (b.citations ?? []).map(citationJson),
        };
      }
      if (b.type === "thinking") return { type: "thinking", thinking: b.thinking, signature: "mock-signature" };
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    }),
    stop_reason: message.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: stopDetails(message),
    usage: { ...usage, service_tier: "standard", inference_geo: null, iterations: null, speed: null },
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`;
}

function chunks(text: string, size: number): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Streaming encoding (SSE) of a message: message_start, content blocks with text_delta,
 * citations_delta, thinking, tool input deltas, message_delta and message_stop.
 */
export function messageSse(message: MockMessage, opts: EncodeOptions): string {
  const size = Math.max(1, opts.chunkChars ?? 16);
  const usage = resolveUsage(message);
  const model = message.model ?? opts.requestModel;
  let out = "";
  out += sse("message_start", {
    message: {
      id: opts.id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { ...usage, output_tokens: 1 },
    },
  });
  blocksOf(message).forEach((block, index) => {
    if (block.type === "text") {
      out += sse("content_block_start", {
        index,
        content_block: { type: "text", text: "", citations: [] },
      });
      for (const piece of chunks(block.text, size)) {
        out += sse("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
      }
      for (const c of block.citations ?? []) {
        out += sse("content_block_delta", {
          index,
          delta: { type: "citations_delta", citation: citationJson(c) },
        });
      }
    } else if (block.type === "thinking") {
      out += sse("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const piece of chunks(block.thinking, size)) {
        out += sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: piece } });
      }
      out += sse("content_block_delta", { index, delta: { type: "signature_delta", signature: "mock-signature" } });
    } else {
      out += sse("content_block_start", {
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sse("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    out += sse("content_block_stop", { index });
  });
  out += sse("message_delta", {
    delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null, stop_details: stopDetails(message) },
    usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens },
  });
  out += sse("message_stop", {});
  return out;
}

/** Error envelope the SDK turns into APIError subclasses by status. */
export function errorBody(status: number, errorType: string | undefined, message: string | undefined): Record<string, unknown> {
  return {
    type: "error",
    error: { type: errorType ?? defaultErrorType(status), message: message ?? `mock error ${status}` },
    request_id: null,
  };
}

export function defaultErrorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}
