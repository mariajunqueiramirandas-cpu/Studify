// The file calls the server code makes, in supabase-js's shapes (ADR 0012). The implementation keeps the bytes on
// the API's disk and the metadata in storage.objects (storage.ts).

export interface StorageError {
  message: string;
  statusCode?: string;
}

export interface StorageResult<T> {
  data: T | null;
  error: StorageError | null;
}

/** A list() entry: a file (id set) or a folder (id null), as Supabase Storage lists them. */
export interface FileObject {
  name: string;
  id: string | null;
  updated_at: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}

export interface UploadOptions {
  contentType?: string;
  upsert?: boolean;
  cacheControl?: string;
}

export interface DbBucket {
  upload(path: string, body: Uint8Array | ArrayBuffer | Blob | string, options?: UploadOptions): Promise<StorageResult<{ path: string; fullPath: string; id: string }>>;
  download(path: string): Promise<StorageResult<Blob>>;
  remove(paths: string[]): Promise<StorageResult<FileObject[]>>;
  list(prefix?: string, options?: { limit?: number; offset?: number }): Promise<StorageResult<FileObject[]>>;
  createSignedUrl(path: string, expiresIn: number, options?: { download?: string | boolean }): Promise<StorageResult<{ signedUrl: string }>>;
  createSignedUrls(paths: string[], expiresIn: number, options?: { download?: string | boolean }): Promise<StorageResult<Array<{ path: string | null; signedUrl: string | null; error: string | null }>>>;
  info(path: string): Promise<StorageResult<{ id: string; name: string; size: number; contentType: string | null; createdAt: string; updatedAt: string }>>;
}

export interface DbStorage {
  from(bucket: string): DbBucket;
}
