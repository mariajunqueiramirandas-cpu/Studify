// Storage paths, downloads and PDF slices (ai-pipeline §4.1; data-model §5.2 document_slices).
// A storage path in the database is `<bucket>/<object path>`, e.g. `documents/{subject}/{doc}.pdf`.
import type { SupabaseClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { ApiFailure } from '@studify/shared';

export const KNOWN_BUCKETS = ['documents', 'slices', 'photos', 'exports', 'media', 'audio'] as const;

export function splitStoragePath(path: string): { bucket: string; object: string } {
  const slash = path.indexOf('/');
  if (slash <= 0) throw new ApiFailure('invalid_request');
  const bucket = path.slice(0, slash);
  if (!(KNOWN_BUCKETS as readonly string[]).includes(bucket)) throw new ApiFailure('invalid_request');
  return { bucket, object: path.slice(slash + 1) };
}

/** True when the object exists. Storage errors other than "not found" are rethrown. */
export async function objectExists(db: SupabaseClient, path: string): Promise<boolean> {
  const { bucket, object } = splitStoragePath(path);
  const { error } = await db.storage.from(bucket).info(object);
  if (!error) return true;
  if (/not.?found|404|does not exist/i.test(error.message ?? '')) return false;
  throw error;
}

export async function downloadBytes(db: SupabaseClient, path: string): Promise<Uint8Array> {
  const { bucket, object } = splitStoragePath(path);
  const { data, error } = await db.storage.from(bucket).download(object);
  if (error || !data) throw new ApiFailure('not_found');
  return new Uint8Array(await data.arrayBuffer());
}

export async function uploadBytes(db: SupabaseClient, path: string, bytes: Uint8Array): Promise<void> {
  const { bucket, object } = splitStoragePath(path);
  const { error } = await db.storage.from(bucket).upload(object, bytes, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
}

/**
 * A PDF with exactly the given original pages (1-based, in the given order). The output page i is
 * original page pages[i]; the model's page index i+1 therefore maps back through the same list.
 */
export async function sliceBytes(source: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { ignoreEncryption: false });
  const total = src.getPageCount();
  const indices = pages.map((p) => p - 1);
  if (indices.some((i) => i < 0 || i >= total)) throw new ApiFailure('invalid_request');
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);
  return out.save();
}

export interface SliceRef {
  id: string;
  documentId: string;
  pageStart: number;
  pageEnd: number;
  storagePath: string;
  /** Pages in order, as original page numbers. */
  pages: number[];
}
