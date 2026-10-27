// @studify/storage — object storage for the API and the worker: Supabase Storage or Cloudflare R2 behind one
// interface. Server-only. The app never holds storage credentials: it asks the API for signed URLs.
export * from './types.ts';
export * from './buckets.ts';
export { supabaseStorage } from './supabase.ts';
export { r2Storage, R2_MAX_TTL_SECONDS, type R2Config } from './r2.ts';
export { createStorage, storageConfigFromEnv, StorageConfigError, type StorageConfig } from './config.ts';
export { contentTypeOf, copyAllObjects, type CopyOptions, type CopyReport } from './copy.ts';
