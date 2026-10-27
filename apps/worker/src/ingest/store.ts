// Object storage for the pipeline: the job context's ObjectStorage (R2 or Supabase Storage, packages/storage).
// Object keys are relative to the bucket. Paths follow the storage policies (migrations 20260101000200):
// the first segment is the authorization key (subject id or document id).
import type { ObjectStorage } from '@studify/storage';

export { StorageError } from '@studify/storage';

/** The part of ObjectStorage the pipeline uses (the integration tests pass an in-memory store). */
export type ObjectStore = Pick<ObjectStorage, 'download' | 'upload' | 'remove'>;

export const BUCKET = {
  documents: 'documents',
  pageImages: 'page-images',
  pageText: 'page-text',
  slices: 'slices',
  photos: 'photos',
} as const;

/** Storage keys for every object the pipeline writes (ING-02, ING-08). */
export const keys = {
  pageImage: (documentId: string, page: number, extension: 'webp' | 'jpg') => `${documentId}/${page}.${extension}`,
  thumb: (documentId: string, page: number) => `${documentId}/thumbs/${page}.jpg`,
  pageText: (documentId: string, page: number) => `${documentId}/${page}.json`,
  slice: (documentId: string, start: number, end: number) => `${documentId}/${start}-${end}.pdf`,
};
