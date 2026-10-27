// Batch lifecycle through the real SDK and the mock server: in_progress -> ended, results in
// reverse order, matched by custom_id. No Claude calls.
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  collectBatch,
  pollBatch,
  submitBatch,
  waitForBatch,
  type BatchItem,
  type BatchItemOutcome,
} from "../src/batch.ts";
import { AiRetryLaterError } from "../src/errors.ts";
import { startMockClaude, type MockClaude, type MockHandler } from "../src/mock/index.ts";
import { CTX, cardsTask, deps, memoryBudget, memoryUsage, structuredCall } from "./helpers.ts";

const GOOD_CARDS = JSON.stringify({
  cards: [{ front: "Pergunta?", back: "Resposta.", source_pages: [1] }],
});

const handler: MockHandler = (req) => {
  switch (req.customId) {
    case "w1_ok":
      return { kind: "message", message: { text: GOOD_CARDS } };
    case "w1_refuse":
      return { kind: "message", message: { text: "", stop_reason: "refusal", refusal_category: "bio" } };
    case "w1_bad":
      return { kind: "error", status: 400, message: "invalid parameter" };
    case "w1_cancel":
      return { kind: "canceled" };
    case "w1_invalid":
      return { kind: "message", message: { text: "não é json" } };
    case undefined:
      // Standard API re-run of a refused item (no custom_id on synchronous requests).
      return { kind: "message", message: { text: GOOD_CARDS } };
    default:
      return undefined;
  }
};

function items(): BatchItem[] {
  return ["w1_ok", "w1_refuse", "w1_bad", "w1_cancel", "w1_invalid"].map((customId) => ({
    customId,
    call: structuredCall({ task: cardsTask }),
  }));
}

let mock: MockClaude;
let sdk: Anthropic;

beforeAll(async () => {
  mock = await startMockClaude({ batchResultOrder: "reverse", batchPollsBeforeEnd: 2 });
  sdk = new Anthropic({ apiKey: "test-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
  mock.setHandler(handler);
});

function byId(outcomes: BatchItemOutcome[]): Record<string, BatchItemOutcome> {
  return Object.fromEntries(outcomes.map((o) => [o.customId, o]));
}

describe("Message Batches lifecycle", () => {
  it("submits with no fallbacks or betas, polls to ended, and collects by custom_id", async () => {
    const budget = memoryBudget();
    const usage = memoryUsage();
    const d = deps(sdk, budget, usage);

    const submission = await submitBatch(d, { ctx: CTX, items: items() });
    expect(submission.batchId).toMatch(/^msgbatch_mock_/);
    expect(budget.reserved[0]).toMatchObject({ mode: "batch", taskId: "cards.generate" });
    expect(budget.reserved[0]?.estimateMicroUsd).toBeGreaterThan(0);

    const submitted = mock.requests[0]?.body as { requests: Array<{ custom_id: string; params: Record<string, unknown> }> };
    expect(submitted.requests.map((r) => r.custom_id)).toEqual(["w1_ok", "w1_refuse", "w1_bad", "w1_cancel", "w1_invalid"]);
    for (const r of submitted.requests) {
      expect("fallbacks" in r.params).toBe(false);
      expect("betas" in r.params).toBe(false);
    }

    const first = await pollBatch(d, submission.batchId);
    expect(first.processingStatus).toBe("in_progress");
    const ended = await waitForBatch(d, submission.batchId, { intervalMs: 0 });
    expect(ended).toEqual({ status: "ended", cancelledByTimeout: false });

    const { outcomes, batchCostMicroUsd } = await collectBatch(d, submission, items());
    const got = byId(outcomes);
    expect(got.w1_ok).toMatchObject({ status: "ok", source: "batch", data: { cards: [{ front: "Pergunta?" }] } });
    expect(got.w1_refuse).toMatchObject({ status: "refused", refusalCategory: "bio" });
    expect(got.w1_bad).toMatchObject({ status: "errored", errorType: "invalid_request_error", retryable: false });
    expect(got.w1_cancel).toMatchObject({ status: "canceled" });
    expect(got.w1_invalid).toMatchObject({ status: "invalid_output" });

    // One usage row per succeeded item (ok, refused, invalid), all priced at the batch rate.
    expect(usage.rows).toHaveLength(3);
    expect(usage.rows.every((r) => r.mode === "batch" && r.batch_id === submission.batchId)).toBe(true);
    expect(usage.rows.map((r) => r.custom_id).sort()).toEqual(["w1_invalid", "w1_ok", "w1_refuse"]);
    expect(budget.settled).toEqual([{ reservationId: submission.reservationId, micro: batchCostMicroUsd }]);
    expect(batchCostMicroUsd).toBeGreaterThan(0);
  });

  it("re-runs refused items on the standard API when asked, and keeps custom_id mapping", async () => {
    const d = deps(sdk);
    const submission = await submitBatch(d, { ctx: CTX, items: items() });
    await waitForBatch(d, submission.batchId, { intervalMs: 0 });

    const { outcomes } = await collectBatch(d, submission, items(), { rerunRefused: true });
    expect(byId(outcomes).w1_refuse).toMatchObject({ status: "ok", source: "standard" });

    const rerun = mock.requests.at(-1);
    expect((rerun?.body as { fallbacks?: string }).fallbacks).toBe("default");
    // the SDK sends `betas` as the anthropic-beta header, not in the body
    expect(rerun?.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  });

  it("cancels a batch that runs past the wait limit and reports unfinished items as canceled", async () => {
    const d = deps(sdk);
    const submission = await submitBatch(d, { ctx: CTX, items: items() });
    // maxWaitMs 0: the first poll triggers the cancel, the next poll sees it finish
    const result = await waitForBatch(d, submission.batchId, { intervalMs: 0, maxWaitMs: 0 });
    expect(result).toEqual({ status: "ended", cancelledByTimeout: true });
    const { outcomes } = await collectBatch(d, submission, items());
    expect(byId(outcomes).w1_ok).toMatchObject({ status: "ok" });
    expect(mock.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
  });

  it("refuses to collect a batch that has not ended", async () => {
    const d = deps(sdk);
    const submission = await submitBatch(d, { ctx: CTX, items: items() });
    await expect(collectBatch(d, submission, items())).rejects.toBeInstanceOf(AiRetryLaterError);
  });

  it("rejects an invalid custom_id before reserving budget or calling the API", async () => {
    mock.setHandler(undefined);
    const budget = memoryBudget();
    const d = deps(sdk, budget);
    const bad: BatchItem[] = [{ customId: "bad id with spaces", call: structuredCall({ task: cardsTask }) }];
    await expect(submitBatch(d, { ctx: CTX, items: bad })).rejects.toThrow(/custom_id/);
    expect(budget.reserved).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });
});
