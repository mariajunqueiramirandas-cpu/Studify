// Storage paths, downloads and PDF slices (ai-pipeline §4.1; data-model §5.2 document_slices).
// A storage path in the database is `<bucket>/<object path>`, e.g. `documents/{subject}/{doc}.pdf`.
import { PDFDocument } from 'pdf-lib';
import { ApiFailure } from '@studify/shared';
import { isNotFound, type ObjectStorage } from '@studify/storage';

export const KNOWN_BUCKETS = ['documents', 'slices', 'photos', 'exports', 'media', 'audio'] as const;

export function splitStoragePath(path: string): { bucket: string; object: string } {
  const slash = path.indexOf('/');
  if (slash <= 0) throw new ApiFailure('invalid_request');
  const bucket = path.slice(0, slash);
  if (!(KNOWN_BUCKETS as readonly string[]).includes(bucket)) throw new ApiFailure('invalid_request');
  return { bucket, object: path.slice(slash + 1) };
}

/**
 * documents.storage_path is relative to the `documents` bucket (`{subject_id}/{document_id}.pdf`), which is how
 * the worker reads and writes it. Rows that already carry the bucket prefix are accepted as they are.
 */
export function documentObjectPath(storagePath: string): string {
  return storagePath.startsWith('documents/') ? storagePath : `documents/${storagePath}`;
}

/** True when the object exists. Storage errors other than "not found" are rethrown. */
export async function objectExists(storage: ObjectStorage, path: string): Promise<boolean> {
  const { bucket, object } = splitStoragePath(path);
  return storage.exists(bucket, object);
}

/** The object's bytes; a missing object is the API's not_found. */
export async function downloadBytes(storage: ObjectStorage, path: string): Promise<Uint8Array> {
  const { bucket, object } = splitStoragePath(path);
  try {
    return await storage.download(bucket, object);
  } catch (err) {
    if (isNotFound(err)) throw new ApiFailure('not_found');
    throw err;
  }
}

export async function uploadBytes(storage: ObjectStorage, path: string, bytes: Uint8Array): Promise<void> {
  const { bucket, object } = splitStoragePath(path);
  await storage.upload(bucket, object, bytes, 'application/pdf');
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
