// The mock server's own behaviour: fixture files, once-fixtures, precedence of queue > handler > fixtures.
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockClaude, type MockClaude } from "../src/mock/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude", import.meta.url));

let mock: MockClaude;
let sdk: Anthropic;

beforeAll(async () => {
  mock = await startMockClaude({ fixturesDir: FIXTURES });
  sdk = new Anthropic({ apiKey: "test-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  mock.setHandler(undefined);
});

const prompt = (text: string) => ({
  model: "claude-opus-5-5",
  max_tokens: 1000,
  messages: [{ role: "user" as const, content: text }],
});

describe("mock Claude server", () => {
  it("serves fixtures in file order, consuming once-fixtures", async () => {
    const first = await sdk.beta.messages.create(prompt("Gere cartões agora"));
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Pergunta?") });

    const second = await sdk.beta.messages.create(prompt("Gere cartões agora")).catch((e: { status?: number }) => e);
    expect((second as { status?: number }).status).toBe(529);

    const third = await sdk.beta.messages.create(prompt("Gere cartões agora")).catch((e: { status?: number }) => e);
    expect((third as { status?: number }).status).toBe(400);
  });

  it("answers with the handler when it returns a response, and falls through to fixtures when it does not", async () => {
    mock.setHandler((req) => (req.bodyText.includes("PING") ? { kind: "message", message: { text: "pong" } } : undefined));
    const pong = await sdk.beta.messages.create(prompt("PING"));
    expect(pong.content[0]).toMatchObject({ text: "pong" });
    // Both once-fixtures were consumed by the first test, so nothing matches and the mock fails loudly.
    const fallthrough = await sdk.beta.messages.create(prompt("Gere cartões")).catch((e: { status?: number; message?: string }) => e);
    expect((fallthrough as { status?: number }).status).toBe(400);
    expect(String((fallthrough as { message?: string }).message)).toMatch(/no fixture matched/);
    expect(mock.requests).toHaveLength(2);
  });

  it("serves queued responses before the handler", async () => {
    mock.setHandler(() => ({ kind: "message", message: { text: "from handler" } }));
    mock.enqueue({ kind: "message", message: { text: "from queue" } });
    const reply = await sdk.beta.messages.create(prompt("oi"));
    expect(reply.content[0]).toMatchObject({ text: "from queue" });
    const next = await sdk.beta.messages.create(prompt("oi"));
    expect(next.content[0]).toMatchObject({ text: "from handler" });
  });

  it("records each request body and headers for assertions", async () => {
    mock.setHandler(() => ({ kind: "message", message: { text: "ok" } }));
    await sdk.beta.messages.create({ ...prompt("oi"), betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never);
    const [recorded] = mock.requests;
    expect(recorded?.path).toBe("/v1/messages");
    expect(recorded?.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect((recorded?.body as { fallbacks?: string }).fallbacks).toBe("default");
  });

  it("streams a text message through the SDK stream helper", async () => {
    mock.setHandler(() => ({ kind: "message", message: { text: "Olá" } }));
    const stream = sdk.beta.messages.stream(prompt("oi"));
    const message = await stream.finalMessage();
    expect(message.content[0]).toMatchObject({ type: "text", text: "Olá" });
    expect(message.stop_reason).toBe("end_turn");
  });
});
