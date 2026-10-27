// Mock Claude HTTP server (node:http) for Edge Function and worker integration tests.
// CI never calls the real API (testing-strategy §5.1, §6.5). Point the real SDK at it with
// `new Anthropic({ baseURL: mock.url, apiKey: "test", maxRetries: 0 })`.
//
// Implements: POST /v1/messages (JSON and SSE), POST /v1/messages/count_tokens, the Message Batches
// lifecycle (create, retrieve, cancel, results as JSONL in a chosen order), and the Files API
// (upload, delete). Responses come from, in order: queued responses, the programmable handler,
// fixture files, and finally a 400 "no fixture matched" so unexpected calls fail loudly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fixtureMatches, loadFixtures, type MockFixture } from "./fixtures.ts";
import { DEFAULT_MODEL, hasServerFallback } from "../models.ts";
import {
  blocksOf,
  defaultErrorType,
  errorBody,
  messageJson,
  messageSse,
  type MockMessage,
  type MockResponse,
} from "./messages.ts";

export type { MockFixture, MockMessage, MockResponse };

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (undefined for multipart or empty bodies). */
  body: unknown;
  bodyText: string;
  /** True when the request asked for SSE (`stream: true`). */
  stream: boolean;
  /** Set for batch items: the item's custom_id. */
  customId?: string;
}

export type MockHandler = (req: MockRequest) => MockResponse | undefined | Promise<MockResponse | undefined>;

export interface MockClaudeOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  host?: string;
  /** Directory of fixture JSON files. See mock/fixtures.ts for the format. */
  fixturesDir?: string;
  handler?: MockHandler;
  /** Batch: number of GET retrieve calls before the batch reports "ended". Default 2 (first poll shows in_progress). */
  batchPollsBeforeEnd?: number;
  /** Batch results order in the JSONL. Default "reverse" to prove callers match by custom_id. */
  batchResultOrder?: "reverse" | "as-is" | "shuffle";
  /** Characters per text_delta event. Default 16. */
  streamChunkChars?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface MockClaude {
  /** Use as the SDK baseURL (the SDK appends /v1/...). */
  url: string;
  port: number;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** Queue a response for the next /v1/messages request. Consumed before handler and fixtures. */
  enqueue(response: MockResponse): void;
  setHandler(handler: MockHandler | undefined): void;
  /** Clears requests, the queue, batches and uploaded files. Fixtures and handler stay. */
  reset(): void;
  close(): Promise<void>;
}

interface BatchRecord {
  id: string;
  items: Array<{ customId: string; result: Record<string, unknown> }>;
  polls: number;
  cancelRequested: boolean;
  ended: boolean;
  createdAt: string;
}

export async function startMockClaude(options: MockClaudeOptions = {}): Promise<MockClaude> {
  const fixtures: MockFixture[] = options.fixturesDir ? loadFixtures(options.fixturesDir) : [];
  const queue: MockResponse[] = [];
  let handler = options.handler;
  const requests: RecordedRequest[] = [];
  const batches = new Map<string, BatchRecord>();
  const files = new Map<string, { filename: string; size: number }>();
  const pollsBeforeEnd = options.batchPollsBeforeEnd ?? 2;
  const resultOrder = options.batchResultOrder ?? "reverse";
  const chunkChars = options.streamChunkChars ?? 16;
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_mock_${String(++seq).padStart(6, "0")}`;

  async function resolve(req: MockRequest): Promise<MockResponse> {
    if (req.customId === undefined && queue.length > 0) {
      return queue.shift() as MockResponse;
    }
    const fromHandler = handler ? await handler(req) : undefined;
    if (fromHandler) return fromHandler;
    const idx = fixtures.findIndex((f) =>
      fixtureMatches(f, { path: req.path, bodyText: req.bodyText, customId: req.customId }),
    );
    if (idx >= 0) {
      const fixture = fixtures[idx] as MockFixture;
      if (fixture.once) fixtures.splice(idx, 1);
      return fixture.respond;
    }
    return {
      kind: "error",
      status: 400,
      errorType: "invalid_request_error",
      message: "mock: no fixture matched this request",
    };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function sendError(res: ServerResponse, spec: Extract<MockResponse, { kind: "error" }>): void {
    const headers: Record<string, string> = {};
    if (spec.retryAfterSeconds !== undefined) headers["retry-after"] = String(spec.retryAfterSeconds);
    sendJson(res, spec.status, errorBody(spec.status, spec.errorType, spec.message), headers);
  }

  function batchResultOf(spec: MockResponse, requestModel: string): Record<string, unknown> {
    switch (spec.kind) {
      case "message":
        return { type: "succeeded", message: messageJson(spec.message, { id: nextId("msg"), requestModel }) };
      case "error":
        return {
          type: "errored",
          error: {
            type: "error",
            error: { type: spec.errorType ?? defaultErrorType(spec.status), message: spec.message ?? "mock error" },
            request_id: null,
          },
        };
      case "canceled":
        return { type: "canceled" };
      case "expired":
        return { type: "expired" };
    }
  }

  async function handleMessages(req: MockRequest, res: ServerResponse): Promise<void> {
    const spec = await resolve(req);
    if (spec.kind === "error") return sendError(res, spec);
    if (spec.kind === "canceled" || spec.kind === "expired") {
      return sendJson(res, 400, errorBody(400, "invalid_request_error", `${spec.kind} is a batch-only result`));
    }
    const model = typeof (req.body as { model?: unknown })?.model === "string"
      ? String((req.body as { model: string }).model)
      : DEFAULT_MODEL;
    // Regression guard: models without a server-side fallback must not receive fallbacks or betas
    // (the SDK sends `betas` as the anthropic-beta header, so check both places).
    const sent = (req.body ?? {}) as Record<string, unknown>;
    const sentBeta = req.headers["anthropic-beta"] !== undefined;
    if (!hasServerFallback(model) && ("fallbacks" in sent || "betas" in sent || sentBeta)) {
      return sendJson(res, 400, errorBody(400, "invalid_request_error", `fallbacks and betas are not accepted on ${model}`));
    }
    const id = nextId("msg");
    if (req.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(messageSse(spec.message, { id, requestModel: model, chunkChars }));
      return;
    }
    sendJson(res, 200, messageJson(spec.message, { id, requestModel: model }));
  }

  async function handleBatchCreate(req: MockRequest, res: ServerResponse): Promise<void> {
    const body = req.body as { requests?: Array<{ custom_id?: unknown; params?: unknown }> } | undefined;
    if (!body || !Array.isArray(body.requests)) {
      return sendJson(res, 400, errorBody(400, "invalid_request_error", "requests must be an array"));
    }
    const seen = new Set<string>();
    const items: BatchRecord["items"] = [];
    for (const r of body.requests) {
      const customId = typeof r.custom_id === "string" ? r.custom_id : "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(customId)) {
        return sendJson(res, 400, errorBody(400, "invalid_request_error", `invalid custom_id "${customId}"`));
      }
      if (seen.has(customId)) {
        return sendJson(res, 400, errorBody(400, "invalid_request_error", `duplicate custom_id "${customId}"`));
      }
      seen.add(customId);
      const params = r.params ?? {};
      if ("fallbacks" in (params as object) || "betas" in (params as object)) {
        return sendJson(res, 400, errorBody(400, "invalid_request_error", "fallbacks are not accepted on batches"));
      }
      const itemReq: MockRequest = {
        method: "POST",
        path: "/v1/messages",
        headers: req.headers,
        body: params,
        bodyText: JSON.stringify(params),
        stream: false,
        customId,
      };
      const spec = await resolve(itemReq);
      const model = String((params as { model?: unknown }).model ?? DEFAULT_MODEL);
      items.push({ customId, result: batchResultOf(spec, model) });
    }
    const batch: BatchRecord = {
      id: nextId("msgbatch"),
      items,
      polls: 0,
      cancelRequested: false,
      ended: false,
      createdAt: new Date().toISOString(),
    };
    batches.set(batch.id, batch);
    sendJson(res, 200, batchJson(batch));
  }

  function batchJson(batch: BatchRecord): Record<string, unknown> {
    const counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    for (const item of batch.items) {
      const t = item.result.type as keyof typeof counts;
      if (batch.ended) counts[t] += 1;
      else counts.processing += 1;
    }
    return {
      id: batch.id,
      type: "message_batch",
      processing_status: batch.ended ? "ended" : batch.cancelRequested ? "canceling" : "in_progress",
      request_counts: counts,
      ended_at: batch.ended ? new Date().toISOString() : null,
      created_at: batch.createdAt,
      expires_at: new Date(Date.parse(batch.createdAt) + 24 * 3600_000).toISOString(),
      cancel_initiated_at: batch.cancelRequested ? batch.createdAt : null,
      archived_at: null,
      results_url: batch.ended ? `/v1/messages/batches/${batch.id}/results` : null,
    };
  }

  function advance(batch: BatchRecord): void {
    if (batch.ended) return;
    if (batch.cancelRequested) {
      // Unfinished items come back as canceled, finished ones keep their result.
      batch.items = batch.items.map((item) =>
        item.result.type === "succeeded" || item.result.type === "errored"
          ? item
          : { customId: item.customId, result: { type: "canceled" } },
      );
      batch.ended = true;
    }
  }

  function orderedItems(batch: BatchRecord): BatchRecord["items"] {
    const items = [...batch.items];
    if (resultOrder === "reverse") return items.reverse();
    if (resultOrder === "shuffle") {
      // Deterministic shuffle so failures reproduce.
      let state = 0x2f6b;
      for (let i = items.length - 1; i > 0; i--) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const j = state % (i + 1);
        [items[i], items[j]] = [items[j] as BatchRecord["items"][number], items[i] as BatchRecord["items"][number]];
      }
    }
    return items;
  }

  function routeBatch(req: MockRequest, res: ServerResponse): boolean {
    const m = /^\/v1\/messages\/batches\/([^/]+)(\/cancel|\/results)?$/.exec(req.path);
    if (!m) return false;
    const batch = batches.get(m[1] ?? "");
    if (!batch) {
      sendJson(res, 404, errorBody(404, "not_found_error", `no batch ${m[1]}`));
      return true;
    }
    const suffix = m[2];
    if (req.method === "GET" && !suffix) {
      batch.polls += 1;
      if (batch.cancelRequested) advance(batch);
      else if (batch.polls >= pollsBeforeEnd) batch.ended = true;
      sendJson(res, 200, batchJson(batch));
      return true;
    }
    if (req.method === "POST" && suffix === "/cancel") {
      batch.cancelRequested = true;
      sendJson(res, 200, batchJson(batch));
      return true;
    }
    if (req.method === "GET" && suffix === "/results") {
      if (!batch.ended) {
        sendJson(res, 400, errorBody(400, "invalid_request_error", "batch has not ended"));
        return true;
      }
      const lines = orderedItems(batch).map((item) =>
        JSON.stringify({ custom_id: item.customId, result: item.result }),
      );
      res.writeHead(200, { "content-type": "application/x-jsonl" });
      res.end(lines.join("\n") + "\n");
      return true;
    }
    return false;
  }

  function handleFileUpload(req: MockRequest, res: ServerResponse, rawSize: number): void {
    const filename = /filename="([^"]+)"/.exec(req.bodyText)?.[1] ?? "upload.bin";
    const id = nextId("file");
    files.set(id, { filename, size: rawSize });
    sendJson(res, 200, {
      id,
      type: "file",
      filename,
      mime_type: "application/pdf",
      size_bytes: rawSize,
      created_at: new Date().toISOString(),
      downloadable: false,
      expires_at: null,
    });
  }

  const server: Server = createServer((incoming, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming as IncomingMessage) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      const bodyText = raw.toString("utf8");
      const url = new URL(incoming.url ?? "/", "http://mock.local");
      const path = url.pathname;
      const method = (incoming.method ?? "GET").toUpperCase();
      let parsed: unknown;
      try {
        parsed = bodyText && !(incoming.headers["content-type"] ?? "").includes("multipart") ? JSON.parse(bodyText) : undefined;
      } catch {
        parsed = undefined;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(incoming.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const req: MockRequest = {
        method,
        path,
        headers,
        body: parsed,
        bodyText,
        stream: (parsed as { stream?: unknown } | undefined)?.stream === true,
      };
      requests.push({ method, path, headers, body: parsed });

      if (method === "POST" && path === "/v1/messages") return handleMessages(req, res);
      if (method === "POST" && path === "/v1/messages/count_tokens") {
        return sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(bodyText.length / 3)) });
      }
      if (method === "POST" && path === "/v1/messages/batches") return handleBatchCreate(req, res);
      if (path.startsWith("/v1/messages/batches/") && routeBatch(req, res)) return;
      if (method === "POST" && path === "/v1/files") return handleFileUpload(req, res, raw.length);
      const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
      if (method === "DELETE" && fileMatch) {
        const id = fileMatch[1] ?? "";
        if (!files.has(id)) return sendJson(res, 404, errorBody(404, "not_found_error", `no file ${id}`));
        files.delete(id);
        return sendJson(res, 200, { id, type: "file_deleted" });
      }
      sendJson(res, 404, errorBody(404, "not_found_error", `no route ${method} ${path}`));
    })().catch((err: unknown) => {
      sendJson(res, 500, errorBody(500, "api_error", err instanceof Error ? err.message : String(err)));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  const host = options.host ?? "127.0.0.1";

  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    enqueue(response) {
      queue.push(response);
    },
    setHandler(next) {
      handler = next;
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      batches.clear();
      files.clear();
    },
    close() {
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
        server.closeAllConnections?.();
      });
    },
  };
}

/** Text of every block of a mock message, joined. Handy for assertions. */
export function mockText(message: MockMessage): string {
  return blocksOf(message)
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
