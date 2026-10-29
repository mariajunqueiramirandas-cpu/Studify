// Object storage for the pipeline. Production uses the API's file store (db.storage, files on the API's disk).
// Object keys are relative to the bucket. Paths follow the storage policies (migrations 20260101000200):
// the first segment is the authorization key (subject id or document id).
import type { Db } from '@studify/db';

export interface ObjectStore {
  download(bucket: string, path: string): Promise<Uint8Array>;
  upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

export const BUCKET = {
  documents: 'documents',
  pageImages: 'page-images',
  pageText: 'page-text',
  slices: 'slices',
  photos: 'photos',
} as const;

export function fileStore(client: Db): ObjectStore {
  return {
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) throw new StorageError(bucket, path, error?.message ?? 'empty download');
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(bucket, path, bytes, contentType) {
      const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new StorageError(bucket, path, error.message);
    },
    async remove(bucket, paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new StorageError(bucket, paths[0] ?? '', error.message);
    },
  };
}

export class StorageError extends Error {
  readonly bucket: string;
  readonly path: string;
  constructor(bucket: string, path: string, message: string) {
    super(`storage ${bucket}: ${message}`);
    this.name = 'StorageError';
    this.bucket = bucket;
    this.path = path;
  }
}

/** Storage keys for every object the pipeline writes (ING-02, ING-08). */
export const keys = {
  pageImage: (documentId: string, page: number, extension: 'webp' | 'jpg') => `${documentId}/${page}.${extension}`,
  thumb: (documentId: string, page: number) => `${documentId}/thumbs/${page}.jpg`,
  pageText: (documentId: string, page: number) => `${documentId}/${page}.json`,
  slice: (documentId: string, start: number, end: number) => `${documentId}/${start}-${end}.pdf`,
};
