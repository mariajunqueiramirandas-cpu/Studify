import { describe, expect, it } from "vitest";
import { callClaude } from "../src/callClaude.ts";
import { BudgetExceededError, AiBadRequestError, AiRetryLaterError, AiUnavailableError } from "../src/errors.ts";
import {
  CTX,
  cardsTask,
  deps,
  fakeClient,
  memoryBudget,
  message,
  proseCall,
  studyNotesTask,
  structuredCall,
} from "./helpers.ts";
import type { BetaCreateParams } from "../src/types.ts";

const GOOD_CARDS = JSON.stringify({
  cards: [{ front: "O que é mitocôndria?", back: "Organela produtora de ATP.", source_pages: [2] }],
});

describe("structured output: one request, Zod validation and item salvage", () => {
  it("returns the parsed data on the first valid response", async () => {
    const { client, calls } = fakeClient(() => message({ text: GOOD_CARDS, stop_reason: "end_turn" }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.cards[0]?.front).toBe("O que é mitocôndria?");
    expect(result.salvage).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("never sends a second request when the output is off-schema", async () => {
    const { client, calls } = fakeClient(() => message({ text: '{"cards": "nope"}' }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("invalid_output");
    expect(calls).toHaveLength(1);
    expect(result.attempts).toBe(1);
  });

  it("fails with invalid_output on non-JSON, still with one request", async () => {
    const { client, calls } = fakeClient(() => message({ text: "isto não é JSON" }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("invalid_output");
    if (result.status !== "invalid_output") throw new Error("unreachable");
    expect(result.issues).toMatch(/not valid JSON/);
    expect(calls).toHaveLength(1);
  });

  it("drops the list items that break the schema and keeps the rest (no retry)", async () => {
    const good = { front: "O que é mitocôndria?", back: "Organela produtora de ATP.", source_pages: [2] };
    const bad = { front: "", back: "sem frente", source_pages: [2] };
    const { client, calls } = fakeClient(() => message({ text: JSON.stringify({ cards: [good, bad, good] }) }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data.cards).toHaveLength(2);
    expect(result.salvage).toMatchObject({ dropped: 1 });
    expect(result.salvage?.issues).toMatch(/cards\.1\.front/);
    expect(calls).toHaveLength(1);
  });

  it("does not salvage when an issue is outside the list items", async () => {
    const { client } = fakeClient(() => message({ text: JSON.stringify({ cards: [], extra: 1 }) }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("invalid_output");
  });

  it("runs the task's postValidate after Zod, and treats its message as invalid output", async () => {
    const task = { ...cardsTask, postValidate: (data: { cards: Array<{ source_pages: number[] }> }) =>
      data.cards.some((c) => c.source_pages.includes(9)) ? "source_pages fora do slice" : null };
    const bad = JSON.stringify({ cards: [{ front: "a", back: "b", source_pages: [9] }] });
    const { client } = fakeClient(() => message({ text: bad }));
    const result = await callClaude(deps(client), structuredCall({ task }));
    expect(result.status).toBe("invalid_output");
    if (result.status !== "invalid_output") throw new Error("unreachable");
    expect(result.issues).toBe("source_pages fora do slice");
  });

  it("strips a code fence around the JSON", async () => {
    const { client } = fakeClient(() => message({ text: "```json\n" + GOOD_CARDS + "\n```" }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("ok");
  });
});

describe("stop_reason handling (ai-pipeline §2.4)", () => {
  it("returns refused without a retry, with the category", async () => {
    const { client, calls } = fakeClient(() =>
      message({ text: "", stop_reason: "refusal", refusal_category: "bio" }),
    );
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.refusalCategory).toBe("bio");
    expect(calls).toHaveLength(1);
  });

  it("maps a Haiku 5.5 refusal (HTTP 200, stop_reason refusal) to refused with no server-side fallback", async () => {
    // Haiku 5.5 has no server-side fallback: the refusal arrives as a normal response, no fallback block.
    const { client, calls } = fakeClient(() =>
      message({ text: "", stop_reason: "refusal", refusal_category: "cyber" }),
    );
    const deps0 = deps(client);
    const result = await callClaude(deps0, structuredCall());
    expect(result).toMatchObject({ status: "refused", refusalCategory: "cyber", stopReason: "refusal", modelServed: "claude-haiku-5-5" });
    expect(calls).toHaveLength(1);
    expect("fallbacks" in calls[0]!).toBe(false);
    expect(deps0.usage.rows[0]).toMatchObject({ stop_reason: "refusal", refusal_category: "cyber", fallback_used: false, model_requested: "claude-haiku-5-5" });
  });

  it("sends structured output with the next max_tokens class up front, so it is not cut off", async () => {
    const { client, calls } = fakeClient(() => message({ text: GOOD_CARDS }));
    await callClaude(deps(client), structuredCall());
    // cards.generate declares class S (8,000); the request carries class M (16,000)
    expect((calls[0] as BetaCreateParams).max_tokens).toBe(16_000);
  });

  it("reports a cut-off structured output as truncated without a second request", async () => {
    const { client, calls } = fakeClient(() => message({ text: '{"cards": [', stop_reason: "max_tokens" }));
    const result = await callClaude(deps(client), structuredCall());
    expect(result.status).toBe("truncated");
    expect(calls).toHaveLength(1);
  });

  it("keeps prose that hit max_tokens and does not retry it", async () => {
    const { client, calls } = fakeClient(() => message({ text: "Parte da resposta", stop_reason: "max_tokens" }));
    const result = await callClaude(deps(client), proseCall(studyNotesTask));
    expect(result.status).toBe("truncated");
    expect(result.text).toBe("Parte da resposta");
    expect(calls).toHaveLength(1);
  });

  it("returns prose text with citations mapped to original pages", async () => {
    const { client } = fakeClient(() =>
      message({
        content: [
          { type: "text", text: "A mitocôndria produz energia.", citations: [{ document_index: 0, start_page_number: 2, end_page_number: 2, cited_text: "produz ATP" }] },
        ],
      }),
    );
    const result = await callClaude(deps(client), proseCall());
    expect(result.status).toBe("ok");
    expect(result.citations).toEqual([
      expect.objectContaining({ valid: true, pageStart: 13, pageEnd: 13, textStart: 0, textEnd: 29, documentId: "doc-1" }),
    ]);
    expect(result.status === "ok" && result.data).toBe("A mitocôndria produz energia.");
  });

  it("returns tool_use blocks to the caller without looping", async () => {
    const { client, calls } = fakeClient(() =>
      message({ content: [{ type: "tool_use", id: "tu_1", name: "marcar_fora_do_material", input: {} }], stop_reason: "tool_use" }),
    );
    const result = await callClaude(deps(client), proseCall());
    expect(result.toolUses).toEqual([{ id: "tu_1", name: "marcar_fora_do_material", input: {} }]);
    expect(calls).toHaveLength(1);
  });
});

describe("request shape sent to the API", () => {
  it("sends Haiku 5.5 at the declared effort, a JSON format for structured tasks, no fallbacks or betas and no sampling params", async () => {
    const { client, calls } = fakeClient(() => message({ text: GOOD_CARDS }));
    await callClaude(deps(client), structuredCall());
    const params = calls[0] as BetaCreateParams & Record<string, unknown>;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
    expect("fallbacks" in params).toBe(false);
    expect("betas" in params).toBe(false);
    expect("temperature" in params).toBe(false);
    expect("thinking" in params).toBe(false);
  });

  it("writes the effort sent into the usage row", async () => {
    // cards.generate declares medium; the request and the usage row both say medium.
    const d = deps(fakeClient(() => message({ text: GOOD_CARDS })).client);
    await callClaude(d, structuredCall());
    expect(cardsTask.effort).toBe("medium");
    expect(d.usage.rows[0]).toMatchObject({ effort: "medium", model_requested: "claude-haiku-5-5", price_version: expect.stringMatching(/haiku-5-5/) });
  });

  it("uses no structured format for citation tasks", async () => {
    const { client, calls } = fakeClient(() => message({ text: "ok" }));
    await callClaude(deps(client), proseCall());
    expect((calls[0] as BetaCreateParams).output_config?.format).toBeUndefined();
  });
});

describe("error classification (ai-pipeline §10.1)", () => {
  function failing(status: number, headers?: Record<string, string>) {
    const err = Object.assign(new Error(`status ${status}`), { status, headers: headers ? new Headers(headers) : undefined });
    return fakeClient(() => {
      throw err;
    });
  }

  it("maps 400 to a bug error that is never retried", async () => {
    const { client, calls } = failing(400);
    await expect(callClaude(deps(client), structuredCall())).rejects.toBeInstanceOf(AiBadRequestError);
    expect(calls).toHaveLength(1);
  });

  it("maps 401 to an unavailable error", async () => {
    const { client } = failing(401);
    await expect(callClaude(deps(client), structuredCall())).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("maps 429 and 529 to retry-later, keeping retry-after", async () => {
    const { client } = failing(429, { "retry-after": "7" });
    const error = await callClaude(deps(client), structuredCall()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiRetryLaterError);
    expect((error as AiRetryLaterError).retryAfterMs).toBe(7_000);
    const { client: overloaded } = failing(529);
    await expect(callClaude(deps(overloaded), structuredCall())).rejects.toBeInstanceOf(AiRetryLaterError);
  });
});

describe("budget gate (ai-pipeline §9.1)", () => {
  it("throws before any request when the reservation is refused", async () => {
    const { client, calls } = fakeClient(() => message({ text: GOOD_CARDS }));
    const budget = memoryBudget({ allow: false });
    const error = await callClaude(deps(client, budget), structuredCall()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).scope).toBe("user_day");
    expect((error as BudgetExceededError).code).toBe("budget_exhausted");
    expect(calls).toHaveLength(0);
    expect(budget.reserved[0]?.ctx).toEqual(CTX);
    expect(budget.settled).toHaveLength(0);
  });

  it("settles the reservation with the actual cost, and writes one usage row for the request", async () => {
    const { client } = fakeClient(() => message({ text: GOOD_CARDS, usage: { input_tokens: 1_000, output_tokens: 1_000 } }));
    const d = deps(client);
    const result = await callClaude(d, structuredCall());
    expect(result.status).toBe("ok");
    expect(d.usage.rows.map((r) => r.attempt)).toEqual([1]);
    expect(d.usage.rows[0]).toMatchObject({ task_id: "cards.generate", prompt_version: "cards.generate@v3", mode: "sync", feature: "MEM-01" });
    expect(d.budget.settled).toHaveLength(1);
    // Haiku 5.5 standard card, prompt <= 100,000 tokens: 1,000 x $0.10 + 1,000 x $0.50 = $0.0006 = 600 micro-USD
    expect(d.budget.settled[0]?.micro).toBe(600);
  });

  it("releases the reservation with 0 when the request fails before any response", async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error("bad"), { status: 400 });
    });
    const d = deps(client);
    await expect(callClaude(d, structuredCall())).rejects.toBeInstanceOf(AiBadRequestError);
    expect(d.budget.settled).toEqual([{ reservationId: "res-1", micro: 0 }]);
    expect(d.usage.rows[0]).toMatchObject({ error_code: "ai_bad_request", cost_micro_usd: 0 });
  });

  it("uses the prose task's maxTokensClass for the reservation estimate", async () => {
    const { client } = fakeClient(() => message({ text: "ok" }));
    const d = deps(client);
    await callClaude(d, proseCall(studyNotesTask));
    expect(d.budget.reserved[0]).toMatchObject({ taskId: "notes.study", promptVersion: "notes.study@v2", mode: "sync" });
    expect(d.budget.reserved[0]?.estimateMicroUsd).toBeGreaterThan(0);
  });
});
