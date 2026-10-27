// The object storage contract the API and the worker use. A stored file is addressed by its logical bucket
// (data-model §7: documents, page-images, photos, …) and its key inside that bucket, the same split the
// database paths use (`<bucket>/<key>`, e.g. `documents/{subject_id}/{document_id}.pdf`).

export type StorageProvider = 'supabase' | 'r2';

/** A URL the app uploads one file to. The client sends `headers` unchanged: they are part of the signature. */
export interface SignedUpload {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
}

export interface SignedUploadOptions {
  contentType: string;
  /** Exact byte length of the body. R2 signs it, so a different size is refused. */
  size: number;
  ttlSeconds: number;
}

export interface ObjectStorage {
  readonly provider: StorageProvider;
  /** The object's bytes. A missing object throws a StorageError with `notFound` set. */
  download(bucket: string, key: string): Promise<Uint8Array>;
  /** Writes the object, replacing what is there. */
  upload(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  exists(bucket: string, key: string): Promise<boolean>;
  /** Removes the objects. Keys that do not exist are ignored. */
  remove(bucket: string, keys: readonly string[]): Promise<void>;
  /** Every key under `prefix/` (the whole bucket for ''), sub-folders included, relative to the bucket. */
  list(bucket: string, prefix: string): Promise<string[]>;
  /** Signed download URL, or null when it cannot be signed (Supabase: the object does not exist). */
  signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string | null>;
  /** Signed upload URL for a client (the app uploads straight to storage, never through the API). */
  signedUpload(bucket: string, key: string, options: SignedUploadOptions): Promise<SignedUpload>;
}

export class StorageError extends Error {
  readonly bucket: string;
  readonly path: string;
  readonly notFound: boolean;
  constructor(bucket: string, path: string, message: string, options: { notFound?: boolean } = {}) {
    super(`storage ${bucket}: ${message}`);
    this.name = 'StorageError';
    this.bucket = bucket;
    this.path = path;
    this.notFound = options.notFound === true;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof StorageError && err.notFound;
}
