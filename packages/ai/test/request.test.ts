import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertRequestShape, buildParams, toJsonSchema } from "../src/request.ts";
import { AiBadRequestError } from "../src/errors.ts";
import { SYNC_REQUEST_DEFAULTS } from "../src/models.ts";
import type { BetaCreateParams, BetaMessageParam } from "../src/types.ts";
import { cardsTask, structuredCall } from "./helpers.ts";

function base(messages: BetaMessageParam[], extra: Partial<BetaCreateParams> = {}): BetaCreateParams {
  return {
    model: "claude-opus-5-5",
    max_tokens: 8_000,
    output_config: { effort: "medium" },
    system: [{ type: "text", text: "SYS" }],
    messages,
    ...extra,
  } as BetaCreateParams;
}

const userText: BetaMessageParam = { role: "user", content: [{ type: "text", text: "oi" }] };

describe("buildParams", () => {
  it("sends the refusal fallback on synchronous requests and never sampling or thinking params", () => {
    const params = buildParams(structuredCall(), { batch: false, maxTokensClass: "S", messages: structuredCall().messages });
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(8_000);
    expect(params.output_config?.effort).toBe("medium");
    expect(params).toMatchObject(SYNC_REQUEST_DEFAULTS);
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) {
      expect(key in params).toBe(false);
    }
  });

  it("omits fallbacks and betas on Batch requests", () => {
    const params = buildParams(structuredCall(), { batch: true, maxTokensClass: "L", messages: structuredCall().messages });
    expect("fallbacks" in params).toBe(false);
    expect("betas" in params).toBe(false);
  });

  it("sends the JSON schema as output_config.format with additionalProperties false", () => {
    const params = buildParams(structuredCall(), { batch: false, maxTokensClass: "S", messages: structuredCall().messages });
    const format = params.output_config?.format;
    expect(format?.type).toBe("json_schema");
    const schema = format?.schema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
    expect(JSON.stringify(schema)).not.toMatch(/"minItems"|"minLength"/);
    expect(cardsTask.output.mode).toBe("structured");
  });
});

describe("toJsonSchema", () => {
  it("strips keywords the API does not enforce and keeps the object shape", () => {
    const schema = z.object({ n: z.number().int().min(0).max(5), s: z.string().min(2), arr: z.array(z.string()).min(1) });
    const json = toJsonSchema(schema);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/"minimum"|"maximum"|"minLength"|"minItems"/);
    expect(json.additionalProperties).toBe(false);
    expect((json.properties as Record<string, unknown>).n).toMatchObject({ type: "integer" });
  });
});

describe("assertRequestShape (Opus 5.5 and API rules)", () => {
  it("passes a well-formed structured request", () => {
    expect(() => assertRequestShape(buildParams(structuredCall(), { batch: false, maxTokensClass: "S", messages: structuredCall().messages }), { batch: false })).not.toThrow();
  });

  it("rejects sampling parameters", () => {
    expect(() => assertRequestShape({ ...base([userText]), temperature: 0.2 } as BetaCreateParams, { batch: false })).toThrow(AiBadRequestError);
  });

  it("rejects an assistant turn at the end (prefill)", () => {
    const params = base([userText, { role: "assistant", content: [{ type: "text", text: "Resposta: (" }] }]);
    expect(() => assertRequestShape(params, { batch: false })).toThrow(/prefill/);
    expect(() => assertRequestShape(params, { batch: false, allowAssistantTail: true })).not.toThrow();
  });

  it("rejects forced tool_choice", () => {
    expect(() => assertRequestShape(base([userText], { tool_choice: { type: "any" } } as Partial<BetaCreateParams>), { batch: false })).toThrow(/tool_choice/);
    expect(() => assertRequestShape(base([userText], { tool_choice: { type: "tool", name: "x" } } as Partial<BetaCreateParams>), { batch: false })).toThrow(/tool_choice/);
  });

  it("rejects fallbacks on Batch requests", () => {
    expect(() => assertRequestShape(base([userText], SYNC_REQUEST_DEFAULTS as Partial<BetaCreateParams>), { batch: true })).toThrow(/Batches API/);
  });

  it("rejects text with citations inside a user turn", () => {
    const params = base([{ role: "user", content: [{ type: "text", text: "x", citations: [{ type: "page_location", cited_text: "x", document_index: 0, document_title: null, start_page_number: 1, end_page_number: 1 }] }] } as BetaMessageParam]);
    expect(() => assertRequestShape(params, { batch: false })).toThrow(/user turns/);
  });

  it("rejects document blocks after text in a user turn", () => {
    const doc = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA" } };
    const params = base([{ role: "user", content: [{ type: "text", text: "antes" }, doc] } as unknown as BetaMessageParam]);
    expect(() => assertRequestShape(params, { batch: false })).toThrow(/precede text/);
  });

  it("rejects citations together with a structured output format", () => {
    const doc = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA" }, citations: { enabled: true } };
    const params = base([{ role: "user", content: [doc, { type: "text", text: "x" }] } as unknown as BetaMessageParam], {
      output_config: { effort: "medium", format: { type: "json_schema", schema: {} } },
    });
    expect(() => assertRequestShape(params, { batch: false })).toThrow(/cannot be combined/);
  });

  it("allows at most four cache breakpoints", () => {
    const system = Array.from({ length: 5 }, (_, i) => ({ type: "text", text: `S${i}`, cache_control: { type: "ephemeral", ttl: "5m" } }));
    expect(() => assertRequestShape(base([userText], { system } as Partial<BetaCreateParams>), { batch: false })).toThrow(/at most 4/);
  });

  it("requires 1h breakpoints before 5m ones", () => {
    const system = [
      { type: "text", text: "A", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    expect(() => assertRequestShape(base([userText], { system } as Partial<BetaCreateParams>), { batch: false })).toThrow(/1h cache breakpoints/);
  });
});
