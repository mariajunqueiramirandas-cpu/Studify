// Files API helpers through the real SDK and the mock server. No Claude calls.
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FILE_RETENTION_MS,
  deleteDocumentFiles,
  deleteFile,
  isFileExpired,
  sweepExpiredFiles,
  uploadSliceFile,
  type FileRecord,
} from "../src/files.ts";
import { startMockClaude, type MockClaude } from "../src/mock/index.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");

let mock: MockClaude;
let sdk: Anthropic;

beforeAll(async () => {
  mock = await startMockClaude();
  sdk = new Anthropic({ apiKey: "test-key", baseURL: mock.url, maxRetries: 0 });
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.reset();
});

describe("Files API bookkeeping (ai-pipeline §4.2)", () => {
  it("uploads a slice and sets the 48 h expiry", async () => {
    const uploaded = await uploadSliceFile(
      { client: sdk, clock: () => NOW },
      { sliceId: "slice-1", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
    );
    expect(uploaded.fileId).toMatch(/^file_mock_/);
    expect(uploaded.expiresAt).toBe(new Date(NOW + FILE_RETENTION_MS).toISOString());
    expect(FILE_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
    expect(mock.requests[0]?.path).toBe("/v1/files");
  });

  it("deletes a file once, then reports already_gone on a 404", async () => {
    const { fileId } = await uploadSliceFile({ client: sdk, clock: () => NOW }, { sliceId: "s", bytes: new Uint8Array([1]) });
    expect(await deleteFile(sdk, fileId)).toBe("deleted");
    expect(await deleteFile(sdk, fileId)).toBe("already_gone");
  });

  it("sweeps only files past their expiry and reports the slices to clear", async () => {
    const a = await uploadSliceFile({ client: sdk, clock: () => NOW - 49 * 3600_000 }, { sliceId: "a", bytes: new Uint8Array([1]) });
    const b = await uploadSliceFile({ client: sdk, clock: () => NOW }, { sliceId: "b", bytes: new Uint8Array([1]) });
    const records: FileRecord[] = [
      { id: "a", anthropic_file_id: a.fileId, anthropic_file_expires_at: a.expiresAt },
      { id: "b", anthropic_file_id: b.fileId, anthropic_file_expires_at: b.expiresAt },
      { id: "c", anthropic_file_id: null, anthropic_file_expires_at: null },
    ];
    const result = await sweepExpiredFiles(sdk, records, NOW);
    expect(result).toEqual({ cleared: ["a"], failed: [] });
    const deletes = mock.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual([`/v1/files/${a.fileId}`]);
  });

  it("deletes every file of a removed document at once", async () => {
    const a = await uploadSliceFile({ client: sdk, clock: () => NOW }, { sliceId: "a", bytes: new Uint8Array([1]) });
    const cleared = await deleteDocumentFiles(sdk, [{ id: "a", anthropic_file_id: a.fileId, anthropic_file_expires_at: a.expiresAt }]);
    expect(cleared).toEqual(["a"]);
  });

  it("treats a missing expiry as not expired", () => {
    expect(isFileExpired({ anthropic_file_expires_at: null }, NOW)).toBe(false);
    expect(isFileExpired({ anthropic_file_expires_at: new Date(NOW).toISOString() }, NOW)).toBe(true);
  });
});
