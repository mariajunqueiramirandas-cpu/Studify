// Uploads to the API's file store with progress (mobile-app.md §9, ADR 0012). Files up to 6 MB use a standard
// upload; larger files use the TUS resumable protocol in 6 MB chunks, retrying a failed chunk from the server's
// reported offset. The server checks every upload against the storage policies, as the signed-in student.
import { getApiUrl } from './env';
import { ApiError, apiErrorFromResponse, offlineError } from './errors';
import { supabase } from './supabase';

const STANDARD_LIMIT_BYTES = 6 * 1024 * 1024;
const CHUNK_BYTES = 6 * 1024 * 1024;
const CHUNK_RETRIES = 3;

export interface UploadOptions {
  bucket: string;
  /** Object path inside the bucket, e.g. `documents/{subject_id}/{document_id}.pdf`. */
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
  headers: (name: string) => string | null;
  text: string;
}

function xhr(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Blob | null,
  onUploadProgress?: (loaded: number) => void,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(method, url, true);
    for (const [k, v] of Object.entries(headers)) req.setRequestHeader(k, v);
    if (onUploadProgress) {
      req.upload.onprogress = (event) => onUploadProgress(event.loaded);
    }
    req.onerror = () => reject(offlineError());
    req.onabort = () => reject(new ApiError('cancelled', 0, 'Envio cancelado.'));
    req.onload = () =>
      resolve({
        status: req.status,
        headers: (name) => req.getResponseHeader(name),
        text: req.responseText ?? '',
      });
    req.send(body);
  });
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError('unauthorized', 401, 'Sua sessão expirou. Entre de novo.');
  return {
    Authorization: `Bearer ${data.session.access_token}`,
    'x-upsert': 'true',
  };
}

function base64(value: string): string {
  return globalThis.btoa(unescape(encodeURIComponent(value)));
}

async function standardUpload(opts: UploadOptions, blob: Blob): Promise<void> {
  const url = `${getApiUrl()}/storage/object/${opts.bucket}/${encodePath(opts.path)}`;
  const res = await xhr(
    'POST',
    url,
    { ...(await authHeaders()), 'Content-Type': opts.contentType },
    blob,
    (loaded) => opts.onProgress?.(Math.round((loaded / Math.max(blob.size, 1)) * 100)),
  );
  if (res.status >= 300) throw apiErrorFromResponse(res.status, res.text);
}

async function tusUpload(opts: UploadOptions, blob: Blob): Promise<void> {
  const base = getApiUrl();
  const common = { ...(await authHeaders()), 'Tus-Resumable': '1.0.0' };
  const metadata = [
    `bucketName ${base64(opts.bucket)}`,
    `objectName ${base64(opts.path)}`,
    `contentType ${base64(opts.contentType)}`,
    `cacheControl ${base64('3600')}`,
  ].join(',');

  const created = await xhr('POST', `${base}/storage/upload/resumable`, {
    ...common,
    'Upload-Length': String(blob.size),
    'Upload-Metadata': metadata,
  }, null);
  if (created.status >= 300) throw apiErrorFromResponse(created.status, created.text);
  const location = created.headers('Location');
  if (!location) throw new ApiError('unknown', created.status, 'Resposta de upload sem Location.');
  // The server answers with a path (/api/storage/upload/resumable/<id>) on its own origin.
  const uploadUrl = new URL(location, base).toString();

  let offset = 0;
  let failures = 0;
  while (offset < blob.size) {
    // The slice is recomputed from `offset` on every attempt, so a resumed offset is always honored.
    const end = Math.min(offset + CHUNK_BYTES, blob.size);
    const base = offset;
    try {
      const res = await xhr(
        'PATCH',
        uploadUrl,
        { ...common, 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        blob.slice(offset, end),
        (loaded) => opts.onProgress?.(Math.round(((base + loaded) / Math.max(blob.size, 1)) * 100)),
      );
      if (res.status >= 300) throw apiErrorFromResponse(res.status, res.text);
      offset = Number(res.headers('Upload-Offset') ?? end);
      failures = 0;
    } catch (error) {
      failures += 1;
      const retryable = error instanceof ApiError && (error.code === 'offline' || error.status === 0);
      if (!retryable || failures > CHUNK_RETRIES) throw error;
      // Ask the server where it stopped, then resend from there.
      const head = await xhr('HEAD', uploadUrl, { ...common }, null);
      if (head.status >= 300) throw apiErrorFromResponse(head.status, head.text);
      offset = Number(head.headers('Upload-Offset') ?? offset);
    }
  }
  opts.onProgress?.(100);
}

/** Uploads a local file. Resolves with the stored object path. */
export async function uploadFile(opts: UploadOptions): Promise<{ path: string }> {
  const blob = await (await fetch(opts.uri)).blob();
  if (blob.size <= STANDARD_LIMIT_BYTES) {
    await standardUpload(opts, blob);
  } else {
    await tusUpload(opts, blob);
  }
  opts.onProgress?.(100);
  return { path: opts.path };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
