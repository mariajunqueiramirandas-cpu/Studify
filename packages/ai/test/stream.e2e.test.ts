// End-to-end: the real @anthropic-ai/sdk pointed at the mock server (baseURL). No Claude calls.
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callClaude, streamClaude } from "../src/callClaude.ts";
import { AiBadRequestError, AiRetryLaterError } from "../src/errors.ts";
import { startMockClaude, type MockClaude, type MockHandler } from "../src/mock/index.ts";
import type { StreamEvent } from "../src/types.ts";
import { cardsTask, deepNotesTask, deps, proseCall, structuredCall } from "./helpers.ts";

const GOOD_CARDS = JSON.stringify({
  cards: [{ front: "Função da mitocôndria?", back: "Produzir ATP.", source_pages: [1] }],
});

let mock: MockClaude;
let sdk: Anthropic;

beforeAll(async () => {
  mock = await startMockClaude({ streamChunkChars: 6 });
  sdk = new Anthropic({ apiKey: "test-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  mock.setHandler(undefined);
});

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function textOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === "text" ? e.text : "")).join("");
}

describe("streaming through the real SDK", () => {
  it("yields text deltas and mapped citations, then an end event, and resolves the result", async () => {
    const handler: MockHandler = () => ({
      kind: "message",
      message: {
        content: [
          {
            type: "text",
            text: "A mitocôndria produz energia para a célula.",
            citations: [{ document_index: 0, start_page_number: 2, end_page_number: 3, cited_text: "produz energia" }],
          },
        ],
      },
    });
    mock.setHandler(handler);

    const handle = streamClaude(deps(sdk), proseCall());
    const events = await drain(handle.events);
    const result = await handle.result;

    expect(textOf(events)).toBe("A mitocôndria produz energia para a célula.");
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
    const citation = events.find((e) => e.type === "citation");
    expect(citation).toMatchObject({
      type: "citation",
      citation: { valid: true, pageStart: 13, pageEnd: 14, documentId: "doc-1" },
    });
    expect(events.at(-1)).toEqual({ type: "end", status: "ok" });
    expect(result.status).toBe("ok");
    expect(result.text).toBe("A mitocôndria produz energia para a célula.");
    expect(result.citations).toEqual([expect.objectContaining({ valid: true, pageStart: 13, pageEnd: 14 })]);

    const sent = mock.requests[0]?.body as { stream?: boolean; fallbacks?: string };
    expect(sent.stream).toBe(true);
    expect(sent.fallbacks).toBe("default");
  });

  it("reports refusals with the partial text marked for discard", async () => {
    mock.setHandler(() => ({
      kind: "message",
      message: { text: "Parte da resposta", stop_reason: "refusal", refusal_category: "bio" },
    }));
    const handle = streamClaude(deps(sdk), proseCall());
    const events = await drain(handle.events);
    expect(events.at(-1)).toEqual({ type: "end", status: "refused" });
    const result = await handle.result;
    expect(result).toMatchObject({ status: "refused", refusalCategory: "bio" });
  });

  it("emits reset before a validation retry so the consumer drops the first attempt", async () => {
    mock.enqueue({ kind: "message", message: { text: '{"cards": "nope"}' } });
    mock.setHandler(() => ({ kind: "message", message: { text: GOOD_CARDS } }));

    const handle = streamClaude(deps(sdk), structuredCall({ task: cardsTask }));
    const events = await drain(handle.events);
    const types = events.map((e) => e.type);
    const resetAt = types.indexOf("reset");
    expect(resetAt).toBeGreaterThan(0);
    expect(types.slice(resetAt + 1)).toContain("text");
    const result = await handle.result;
    expect(result.status).toBe("ok");
    expect(mock.requests).toHaveLength(2);
  });

  it("streams long-output tasks (class L) automatically, even through callClaude", async () => {
    mock.setHandler(() => ({ kind: "message", message: { text: "Notas longas." } }));
    const result = await callClaude(deps(sdk), proseCall(deepNotesTask));
    expect(result.status).toBe("ok");
    expect((mock.requests[0]?.body as { stream?: boolean }).stream).toBe(true);
  });
});

describe("error classification through the real SDK", () => {
  it("retries a 529 inside the SDK (maxRetries) and then succeeds", async () => {
    mock.enqueue({ kind: "error", status: 529, retryAfterSeconds: 0, message: "Overloaded" });
    mock.setHandler(() => ({ kind: "message", message: { text: GOOD_CARDS } }));
    const d = { ...deps(sdk), maxRetries: 1 };
    const result = await callClaude(d, structuredCall());
    expect(result.status).toBe("ok");
    expect(mock.requests).toHaveLength(2);
  });

  it("classifies a 429 that survives the SDK retries as retry-later", async () => {
    mock.enqueue({ kind: "error", status: 429, retryAfterSeconds: 3, message: "slow down" });
    const error = await callClaude(deps(sdk), structuredCall()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiRetryLaterError);
    expect((error as AiRetryLaterError).status).toBe(429);
    expect((error as AiRetryLaterError).retryAfterMs).toBe(3_000);
  });

  it("classifies an unmatched request (400) as a bug and does not retry it", async () => {
    const error = await callClaude(deps(sdk), structuredCall()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiBadRequestError);
    expect(mock.requests).toHaveLength(1);
  });
});
