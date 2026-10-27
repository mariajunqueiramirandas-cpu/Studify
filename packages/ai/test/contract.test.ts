// Compile-time contract: the real SDK client must satisfy AnthropicLike, or the injection point
// breaks for the worker and Edge Functions. Checked by `tsc -p tsconfig.json`; the runtime
// assertion is a placeholder so vitest reports the file.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { AnthropicLike, BudgetStore, UsageSink } from "../src/types.ts";
import { classifyError } from "../src/errors.ts";

describe("injection contract", () => {
  it("accepts the real SDK client as AnthropicLike", () => {
    const client: AnthropicLike = new Anthropic({ apiKey: "test-key", baseURL: "http://127.0.0.1:1" });
    expect(typeof client.beta.messages.create).toBe("function");
  });

  it("classifies non-API errors unchanged", () => {
    const plain = new TypeError("boom");
    expect(classifyError(plain)).toBe(plain);
    const abort = Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
    expect(classifyError(abort)).toBe(abort);
  });

  it("declares the budget and usage interfaces callers implement", () => {
    const budget: BudgetStore = { reserve: async () => ({ ok: true, reservationId: "r" }), settle: async () => undefined };
    const usage: UsageSink = { record: async () => undefined };
    expect(budget && usage).toBeTruthy();
  });
});
