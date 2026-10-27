// The logical buckets (data-model §7, migrations 20260101000200_storage.sql and 20260106000000_phase4.sql).
// Supabase enforces the size and MIME limits on its buckets; with R2 the API enforces them when it signs an
// upload (one R2 bucket holds every logical bucket under its own prefix). Keep both lists in step.

export interface BucketRule {
  /** Largest object a client may upload, in bytes. */
  maxBytes: number;
  mimeTypes: readonly string[];
}

const MB = 1024 * 1024;
/** supabase/config.toml storage.file_size_limit: the limit of buckets without their own. */
export const DEFAULT_MAX_BYTES = 50 * MB;

export const BUCKETS = {
  documents: { maxBytes: 100 * MB, mimeTypes: ['application/pdf'] },
  'page-images': { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['image/webp', 'image/jpeg'] },
  'page-text': { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['application/json'] },
  slices: { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['application/pdf'] },
  media: { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['image/webp', 'image/jpeg', 'image/png'] },
  photos: { maxBytes: 15 * MB, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] },
  audio: { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['audio/mpeg', 'audio/mp4'] },
  enem: { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['image/webp', 'image/jpeg', 'application/pdf', 'text/csv', 'text/plain', 'application/json'] },
  avatars: { maxBytes: 1 * MB, mimeTypes: ['image/webp'] },
  exports: { maxBytes: DEFAULT_MAX_BYTES, mimeTypes: ['application/zip'] },
} as const satisfies Record<string, BucketRule>;

export type BucketName = keyof typeof BUCKETS;

export function isBucketName(value: string): value is BucketName {
  return Object.hasOwn(BUCKETS, value);
}

export interface ObjectPath {
  bucket: BucketName;
  key: string;
  /** The key's segments: folders first, the file name last. */
  segments: string[];
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Splits a client-supplied `<bucket>/<key>` path. Null when the bucket is unknown or a segment is not a plain
 * name (no empty segments, no `.`/`..`, no characters outside [A-Za-z0-9._-]): every path the app builds
 * is made of ids and fixed names, so anything else is refused rather than normalized.
 */
export function parseObjectPath(path: string): ObjectPath | null {
  if (path.length === 0 || path.length > 1024) return null;
  const [bucket, ...segments] = path.split('/');
  if (!bucket || !isBucketName(bucket) || segments.length === 0) return null;
  if (!segments.every((s) => SEGMENT.test(s))) return null;
  return { bucket, key: segments.join('/'), segments };
}
