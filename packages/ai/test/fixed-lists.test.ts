// Exact-length lists are sent as objects with that many required keys (the API accepts minItems of 0 or 1 only, and
// no tuple forms), and turned back into lists before Zod. Found with the real API: trail.reinforce asked for exactly
// 4 test questions, got 3, and lost the whole call to Zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sanitizeTools, toJsonSchema } from "../src/request.ts";
import { parseStructured } from "../src/interpret.ts";
import type { TaskDef } from "../src/types.ts";

const Question = z.strictObject({
  stem: z.string().min(1).max(320),
  options: z.array(z.strictObject({ id: z.enum(["A", "B", "C", "D"]), text: z.string() })).length(4),
});
const Reinforcement = z.strictObject({
  remedial: z.array(Question).length(3),
  test: z.array(Question).length(4),
  extra: z.array(Question).min(1).max(5),
  maybe: z.array(z.string()).length(2).nullable(),
});
const task: TaskDef<z.infer<typeof Reinforcement>> = {
  id: "trail.reinforce",
  version: 1,
  features: ["TRL-01"],
  effort: "medium",
  maxTokensClass: "L",
  output: { mode: "structured", schema: Reinforcement },
};

const question = (n: number) => ({
  stem: `Pergunta ${n}?`,
  options: { item_1: { id: "A", text: "a" }, item_2: { id: "B", text: "b" }, item_3: { id: "C", text: "c" }, item_4: { id: "D", text: "d" } },
});
const keyed = (items: unknown[]) => Object.fromEntries(items.map((v, i) => [`item_${i + 1}`, v]));

describe("fixed-length lists in the output format", () => {
  const schema = toJsonSchema(Reinforcement) as {
    properties: Record<string, Record<string, unknown>>;
    definitions: Record<string, Record<string, unknown>>;
  };

  it("sends an exact-length list as an object whose N keys are all required", () => {
    const test = schema.properties.test!;
    expect(test.type).toBe("object");
    expect(test.required).toEqual(["item_1", "item_2", "item_3", "item_4"]);
    expect(test.additionalProperties).toBe(false);
    expect(schema.properties.remedial!.required).toEqual(["item_1", "item_2", "item_3"]);
  });

  it("sends the item schema once, under definitions, so the grammar does not grow with N", () => {
    const refs = Object.values(schema.properties.test!.properties as Record<string, { $ref: string }>).map((p) => p.$ref);
    expect(new Set(refs).size).toBe(1);
    expect((schema.properties.remedial!.properties as Record<string, { $ref: string }>).item_1!.$ref).toBe(refs[0]);
    // One definition per distinct item: the option, the question (shared by both lists) and the string of `maybe`.
    expect(Object.keys(schema.definitions).length).toBe(3);
  });

  it("keeps ranged lists as lists, with the range in the description", () => {
    expect(schema.properties.extra!.type).toBe("array");
    expect(schema.properties.extra!.description).toBe("de 1 a 5 itens");
  });

  it("leaves tool schemas alone (tool input is parsed elsewhere)", () => {
    const [tool] = sanitizeTools([
      { name: "t", description: "d", input_schema: z.toJSONSchema(Reinforcement, { target: "draft-7" }) as never },
    ]);
    expect((tool as { input_schema: { properties: Record<string, { type: string }> } }).input_schema.properties.test!.type).toBe("array");
  });

  it("turns the keyed objects back into lists, nested and nullable included, before Zod", () => {
    const text = JSON.stringify({
      remedial: keyed([1, 2, 3].map(question)),
      test: keyed([4, 5, 6, 7].map(question)),
      extra: [question(8)],
      maybe: keyed(["x", "y"]),
    });
    const parsed = parseStructured(text, task);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.test.map((q) => q.stem)).toEqual(["Pergunta 4?", "Pergunta 5?", "Pergunta 6?", "Pergunta 7?"]);
    expect(parsed.data.test[0]!.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"]);
    expect(parsed.data.extra[0]!.options).toHaveLength(4);
    expect(parsed.data.maybe).toEqual(["x", "y"]);
  });

  it("still accepts plain lists (a model or fixture that wrote the list itself)", () => {
    const plain = (n: number) => ({ ...question(n), options: Object.values(question(n).options) });
    const text = JSON.stringify({ remedial: [1, 2, 3].map(plain), test: [4, 5, 6, 7].map(plain), extra: [plain(8)], maybe: null });
    expect(parseStructured(text, task).ok).toBe(true);
  });

  it("leaves a keyed object with the wrong keys for Zod to reject", () => {
    const text = JSON.stringify({
      remedial: keyed([1, 2, 3].map(question)),
      test: keyed([4, 5, 6].map(question)),
      extra: [question(8)],
      maybe: null,
    });
    expect(parseStructured(text, task).ok).toBe(false);
  });
});
