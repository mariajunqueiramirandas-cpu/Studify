// Files API helpers with the ephemeral-id rule of ai-pipeline §4.2 and data-model R14:
// file ids live at most 48 h. The uploading job deletes its files when it finishes, an hourly sweep
// deletes anything past anthropic_file_expires_at, and deleting a document deletes its files at once.
// Runtime-neutral: the caller persists the returned ids (document_slices) and runs the sweep.

import { classifyError } from "./errors.ts";
import type { AnthropicLike } from "./types.ts";

/** Upload + 48 h, long enough for a Batch run (§4.2). */
export const FILE_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface UploadedSliceFile {
  fileId: string;
  /** ISO timestamp. Store as document_slices.anthropic_file_expires_at. */
  expiresAt: string;
}

export interface FileRecord {
  /** document_slices.id */
  id: string;
  anthropic_file_id: string | null;
  /** ISO timestamp or null. */
  anthropic_file_expires_at: string | null;
}

/** Uploads one PDF slice. The bytes are a PDF; the file is named after the slice id. */
export async function uploadSliceFile(
  deps: { client: AnthropicLike; clock?: () => number },
  input: { sliceId: string; bytes: Uint8Array },
): Promise<UploadedSliceFile> {
  const clock = deps.clock ?? Date.now;
  const file = new File([input.bytes], `${input.sliceId}.pdf`, { type: "application/pdf" });
  try {
    const meta = await deps.client.files.upload({ file });
    return {
      fileId: meta.id,
      expiresAt: new Date(clock() + FILE_RETENTION_MS).toISOString(),
    };
  } catch (err) {
    throw classifyError(err);
  }
}

export type DeleteOutcome = "deleted" | "already_gone";

/** Deletes a file. A 404 means it is already gone, which counts as success for the sweeper. */
export async function deleteFile(client: AnthropicLike, fileId: string): Promise<DeleteOutcome> {
  try {
    await client.files.delete(fileId);
    return "deleted";
  } catch (err) {
    if (statusOf(err) === 404) return "already_gone";
    throw classifyError(err);
  }
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isFileExpired(record: Pick<FileRecord, "anthropic_file_expires_at">, nowMs: number): boolean {
  if (!record.anthropic_file_expires_at) return false;
  const expires = Date.parse(record.anthropic_file_expires_at);
  return Number.isFinite(expires) && expires <= nowMs;
}

export interface SweepResult {
  /** Slice ids whose anthropic_file_id should be cleared in the database. */
  cleared: string[];
  /** Per-file failures. They are retried on the next sweep. */
  failed: Array<{ sliceId: string; fileId: string; message: string }>;
}

/**
 * Deletes every expired file and reports which slices to clear. Files that are still in
 * retention are left alone. Fails soft per file so one bad id does not stop the sweep.
 */
export async function sweepExpiredFiles(
  client: AnthropicLike,
  records: readonly FileRecord[],
  nowMs: number,
): Promise<SweepResult> {
  const cleared: string[] = [];
  const failed: SweepResult["failed"] = [];
  for (const record of records) {
    if (!record.anthropic_file_id || !isFileExpired(record, nowMs)) continue;
    try {
      await deleteFile(client, record.anthropic_file_id);
      cleared.push(record.id);
    } catch (err) {
      failed.push({
        sliceId: record.id,
        fileId: record.anthropic_file_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { cleared, failed };
}

/** Deletes every file of a deleted document right away (spec 01 §8.6). Returns the slice ids to clear. */
export async function deleteDocumentFiles(client: AnthropicLike, records: readonly FileRecord[]): Promise<string[]> {
  const cleared: string[] = [];
  for (const record of records) {
    if (!record.anthropic_file_id) continue;
    await deleteFile(client, record.anthropic_file_id);
    cleared.push(record.id);
  }
  return cleared;
}
