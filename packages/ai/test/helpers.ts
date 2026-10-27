// Shared test fixtures: a fake Anthropic client for unit tests, in-memory budget and usage stores,
// sample tasks and PDF slices. The real SDK is used only in the end-to-end tests (mock server).

import { z } from "zod";
import { messageJson, type MockMessage } from "../src/mock/messages.ts";
import type {
  AiUsageRow,
  AnthropicLike,
  BetaCreateParams,
  BetaMessage,
  BudgetContext,
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetStore,
  ClaudeDeps,
  DocumentSlice,
  TaskCall,
  TaskDef,
  UsageSink,
} from "../src/types.ts";
import { documentBlocks } from "../src/pdf.ts";

export const CTX: BudgetContext = {
  userId: "00000000-0000-4000-8000-000000000001",
  classGroupId: null,
  subjectId: "00000000-0000-4000-8000-000000000002",
  feature: "MEM-01",
  budgetClass: "user",
};

export const CardsSchema = z
  .object({
    cards: z
      .array(
        z
          .object({
            front: z.string().min(1),
            back: z.string().min(1),
            source_pages: z.array(z.number().int()).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Cards = z.infer<typeof CardsSchema>;

export const cardsTask: TaskDef<Cards> = {
  id: "cards.generate",
  version: 3,
  features: ["MEM-01.1"],
  effort: "medium",
  maxTokensClass: "S",
  output: { mode: "structured", schema: CardsSchema },
};

export const studyNotesTask: TaskDef<string> = {
  id: "notes.study",
  version: 2,
  features: ["LRN-01.3"],
  effort: "medium",
  maxTokensClass: "M",
  output: { mode: "citations" },
};

export const deepNotesTask: TaskDef<string> = {
  ...studyNotesTask,
  id: "notes.deep",
  maxTokensClass: "L",
};

export const SLICE: DocumentSlice = {
  id: "slice-1",
  documentId: "doc-1",
  title: "Biologia — Célula",
  pages: [12, 13, 14, 40, 41],
  tokenCount: 5_000,
  base64: "JVBERi0xLjQK",
};

export function sliceBlocks(citations: boolean, source: "base64" | "file" = "base64") {
  const slice: DocumentSlice = source === "file" ? { ...SLICE, anthropicFileId: "file_abc", base64: undefined } : SLICE;
  return documentBlocks([slice], { source, citations, cacheTtl: "1h" });
}

export function structuredCall(overrides: Partial<TaskCall<Cards>> = {}): TaskCall<Cards> {
  const { blocks, sourceMap } = sliceBlocks(false);
  return {
    task: cardsTask,
    ctx: CTX,
    system: [{ text: "SYS: cards", cacheTtl: "1h" }],
    messages: [{ role: "user", content: [...blocks, { type: "text", text: "Gere cartões." }] }],
    sources: sourceMap,
    ...overrides,
  };
}

export function proseCall(task: TaskDef<string> = studyNotesTask, overrides: Partial<TaskCall<string>> = {}): TaskCall<string> {
  const { blocks, sourceMap } = sliceBlocks(true);
  return {
    task,
    ctx: CTX,
    system: [{ text: "SYS: notes", cacheTtl: "1h" }],
    messages: [{ role: "user", content: [...blocks, { type: "text", text: "Escreva as notas." }] }],
    sources: sourceMap,
    ...overrides,
  };
}

/** A BetaMessage built with the mock's own JSON encoder (same shape the SDK parses). */
export function message(spec: MockMessage, id = "msg_test_1"): BetaMessage {
  return messageJson(spec, { id, requestModel: "claude-opus-5-5" }) as unknown as BetaMessage;
}

export interface FakeClient {
  client: AnthropicLike;
  /** Params of every create() call, in order. */
  calls: BetaCreateParams[];
}

/**
 * Non-streaming fake. `respond(params, callIndex)` returns a message or throws an error with a
 * `status` (as the SDK does). Streaming and batch methods throw, so unit tests never reach them.
 */
export function fakeClient(respond: (params: BetaCreateParams, index: number) => BetaMessage): FakeClient {
  const calls: BetaCreateParams[] = [];
  const unused = (name: string) => () => {
    throw new Error(`fake client: ${name} not expected in this test`);
  };
  const client = {
    beta: {
      messages: {
        create: async (params: BetaCreateParams) => {
          calls.push(structuredClone(params));
          return respond(params, calls.length);
        },
        stream: unused("stream"),
        batches: {
          create: unused("batches.create"),
          retrieve: unused("batches.retrieve"),
          cancel: unused("batches.cancel"),
          results: unused("batches.results"),
        },
      },
    },
    files: {
      upload: unused("files.upload"),
      delete: unused("files.delete"),
    },
  } as unknown as AnthropicLike;
  return { client, calls };
}

export interface MemoryBudget extends BudgetStore {
  reserved: BudgetReserveInput[];
  settled: Array<{ reservationId: string; micro: number }>;
}

export function memoryBudget(options: { allow?: boolean } = {}): MemoryBudget {
  const reserved: BudgetReserveInput[] = [];
  const settled: Array<{ reservationId: string; micro: number }> = [];
  return {
    reserved,
    settled,
    async reserve(input: BudgetReserveInput): Promise<BudgetReserveResult> {
      reserved.push(input);
      if (options.allow === false) {
        return { ok: false, scope: "user_day", resetsAt: "2026-10-28T03:00:00.000Z" };
      }
      return { ok: true, reservationId: `res-${reserved.length}` };
    },
    async settle(reservationId: string, micro: number): Promise<void> {
      settled.push({ reservationId, micro });
    },
  };
}

export interface MemoryUsage extends UsageSink {
  rows: AiUsageRow[];
}

export function memoryUsage(): MemoryUsage {
  const rows: AiUsageRow[] = [];
  return {
    rows,
    async record(row: AiUsageRow) {
      rows.push(row);
    },
  };
}

/** Deps with no real waiting: sleep is immediate and the clock is a fixed instant. */
export function deps(client: AnthropicLike, budget = memoryBudget(), usage = memoryUsage()): ClaudeDeps & {
  budget: MemoryBudget;
  usage: MemoryUsage;
} {
  return {
    client,
    budget,
    usage,
    clock: () => Date.parse("2026-10-27T12:00:00.000Z"),
    sleep: async () => undefined,
    maxRetries: 0,
    timeoutMs: 5_000,
  };
}
