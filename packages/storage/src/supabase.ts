// Supabase Storage backend (the service-role client). Used when R2 is not configured: local runs against
// `supabase start`, tests, and deployments that have not moved their files yet.
import type { SupabaseClient } from '@supabase/supabase-js';
import { StorageError, type ObjectStorage } from './types.ts';

const NOT_FOUND = /not.?found|404|does not exist/i;
/** Supabase Storage removes at most this many objects per call. */
const REMOVE_CHUNK = 100;
const LIST_PAGE = 1000;

function failure(bucket: string, path: string, error: { message?: string } | null | undefined, fallback: string): StorageError {
  const message = error?.message ?? fallback;
  return new StorageError(bucket, path, message, { notFound: NOT_FOUND.test(message) });
}

export function supabaseStorage(client: SupabaseClient): ObjectStorage {
  const from = (bucket: string) => client.storage.from(bucket);
  return {
    provider: 'supabase',

    async download(bucket, key) {
      const { data, error } = await from(bucket).download(key);
      if (error || !data) throw failure(bucket, key, error, 'empty download');
      return new Uint8Array(await data.arrayBuffer());
    },

    async upload(bucket, key, bytes, contentType) {
      const { error } = await from(bucket).upload(key, bytes, { contentType, upsert: true });
      if (error) throw failure(bucket, key, error, 'upload failed');
    },

    async exists(bucket, key) {
      const { error } = await from(bucket).info(key);
      if (!error) return true;
      if (NOT_FOUND.test(error.message ?? '')) return false;
      throw failure(bucket, key, error, 'info failed');
    },

    async remove(bucket, keys) {
      for (let i = 0; i < keys.length; i += REMOVE_CHUNK) {
        const part = keys.slice(i, i + REMOVE_CHUNK);
        const { error } = await from(bucket).remove(part);
        if (error) throw failure(bucket, part[0] ?? '', error, 'remove failed');
      }
    },

    // Supabase lists one folder level at a time: files carry an id, sub-folders have id null.
    async list(bucket, prefix) {
      const files: string[] = [];
      const folders = [prefix.replace(/\/+$/, '')];
      while (folders.length > 0) {
        const folder = folders.pop() as string;
        for (let offset = 0; ; offset += LIST_PAGE) {
          const { data, error } = await from(bucket).list(folder, { limit: LIST_PAGE, offset });
          if (error) throw failure(bucket, folder, error, 'list failed');
          const entries = data ?? [];
          for (const entry of entries) {
            const path = folder ? `${folder}/${entry.name}` : entry.name;
            if (entry.id === null) folders.push(path);
            else files.push(path);
          }
          if (entries.length < LIST_PAGE) break;
        }
      }
      return files;
    },

    async signedUrl(bucket, key, ttlSeconds) {
      const { data, error } = await from(bucket).createSignedUrl(key, ttlSeconds);
      return error || !data ? null : data.signedUrl;
    },

    // The token in the URL carries the upsert flag; the bucket's own limits check size and type.
    async signedUpload(bucket, key, { contentType }) {
      const { data, error } = await from(bucket).createSignedUploadUrl(key, { upsert: true });
      if (error || !data) throw failure(bucket, key, error, 'could not sign the upload');
      return { method: 'PUT', url: data.signedUrl, headers: { 'Content-Type': contentType, 'x-upsert': 'true' } };
    },
  };
}
