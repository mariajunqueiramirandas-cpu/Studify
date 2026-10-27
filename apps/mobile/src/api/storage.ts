// Stored files (mobile-app.md §9, data-model §7). The app never writes to storage with its own credentials:
// the API checks the storage policies and signs one URL per file (storage-upload), and the file goes straight
// to storage (R2 or Supabase Storage) with a PUT that reports progress. A dropped connection retries the
// whole file with a fresh URL. Downloads use signed URLs from storage-sign.
import type { StorageSignReq, StorageSignRes, StorageUploadReq, StorageUploadRes } from '@studify/shared';
import { getEnv } from './env';
import { ApiError, apiErrorFromResponse, offlineError } from './errors';
import { callFunction } from './functions';

const UPLOAD_RETRIES = 2;
/** storage-sign takes at most this many paths per call. */
const SIGN_BATCH = 100;

export interface UploadOptions {
  bucket: string;
  /** Object path inside the bucket, e.g. `{subject_id}/{document_id}.pdf` in `documents`. */
  path: string;
  /** Local file URI (file://...) from the picker or camera. */
  uri: string;
  contentType: string;
  /** Receives 0–100. */
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

interface XhrResult {
  status: number;
  text: string;
}

function put(url: string, headers: Record<string, string>, body: Blob, onUploadProgress: (loaded: number) => void, signal?: AbortSignal): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) req.setRequestHeader(k, v);
    req.upload.onprogress = (event) => onUploadProgress(event.loaded);
    req.onerror = () => reject(offlineError());
    req.onabort = () => reject(new ApiError('cancelled', 0, 'Envio cancelado.'));
    req.onload = () => resolve({ status: req.status, text: req.responseText ?? '' });
    signal?.addEventListener('abort', () => req.abort(), { once: true });
    req.send(body);
  });
}

/** Uploads a local file. Resolves with the stored object path. */
export async function uploadFile(opts: UploadOptions): Promise<{ path: string }> {
  const blob = await (await fetch(opts.uri)).blob();
  const env = getEnv();
  for (let attempt = 0; ; attempt++) {
    let signed: StorageUploadRes;
    try {
      signed = await callFunction<StorageUploadReq, StorageUploadRes>(
        'storage-upload',
        { path: `${opts.bucket}/${opts.path}`, content_type: opts.contentType, size: blob.size },
        { signal: opts.signal },
      );
    } catch (error) {
      // Write-once buckets refuse a second URL: after a dropped connection the first PUT may have landed.
      // The path carries an id this device just made, so the stored file is this one.
      if (attempt > 0 && error instanceof ApiError && error.code === 'already_exists') break;
      throw error;
    }
    // Supabase Storage sits behind the API gateway, which wants the project key; R2 URLs carry everything.
    const headers = signed.url.startsWith(env.url) ? { ...signed.headers, apikey: env.anonKey } : signed.headers;
    try {
      const res = await put(signed.url, headers, blob, (loaded) => opts.onProgress?.(Math.round((loaded / Math.max(blob.size, 1)) * 100)), opts.signal);
      if (res.status >= 300) throw apiErrorFromResponse(res.status, res.text);
      break;
    } catch (error) {
      const retryable = error instanceof ApiError && error.code === 'offline';
      if (!retryable || attempt >= UPLOAD_RETRIES) throw error;
    }
  }
  opts.onProgress?.(100);
  return { path: opts.path };
}

/** Signed download URLs (1 h) for `bucket/key` paths, in order; null where the student may not read the file. */
export async function signedUrls(paths: readonly string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < paths.length; i += SIGN_BATCH) {
    const res = await callFunction<StorageSignReq, StorageSignRes>('storage-sign', { paths: paths.slice(i, i + SIGN_BATCH) });
    out.push(...res.urls);
  }
  return out;
}
