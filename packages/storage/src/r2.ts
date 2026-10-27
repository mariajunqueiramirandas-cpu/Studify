// Cloudflare R2 backend over the S3-compatible API, signed with aws4fetch (SigV4, WebCrypto: runs on Bun and
// Node). One R2 bucket holds every logical bucket as a key prefix, so the database path
// `documents/{subject_id}/{document_id}.pdf` is also the R2 key. R2 has no row-level security: clients only
// ever get presigned URLs, which the API signs after its own access checks.
import { createHash } from 'node:crypto';
import { AwsV4Signer } from 'aws4fetch';
import { StorageError, type ObjectStorage, type SignedUpload } from './types.ts';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The R2 bucket that holds every logical bucket. */
  bucket: string;
  /** S3 endpoint. Default https://{accountId}.r2.cloudflarestorage.com (EU jurisdiction: …eu.r2.cloudflarestorage.com). */
  endpoint?: string;
}

/** Longest presigned URL R2 accepts (7 days). */
export const R2_MAX_TTL_SECONDS = 604_800;
/** DeleteObjects takes at most 1000 keys per request. */
const DELETE_CHUNK = 1000;
const ATTEMPTS = 3;

type Fetch = (input: Request) => Promise<Response>;

export function r2Storage(config: R2Config, fetchImpl: Fetch = (req) => fetch(req)): ObjectStorage {
  const endpoint = (config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: 'auto' };
  const bucketUrl = `${endpoint}/${encodeURIComponent(config.bucket)}`;
  const objectUrl = (bucket: string, key: string) => `${bucketUrl}/${encodeKey(`${bucket}/${key}`)}`;

  /** Signs and sends one request; 5xx, 429 and network errors are retried with a short backoff. */
  async function send(method: string, url: string, init: { headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      const body = init.body as RequestInit['body'];
      const signed = await new AwsV4Signer({ ...credentials, method, url, headers: init.headers ?? {}, body }).sign();
      try {
        const res = await fetchImpl(new Request(signed.url.toString(), { method, headers: signed.headers, body }));
        if (res.status < 500 && res.status !== 429) return res;
        lastError = new Error(`HTTP ${res.status}`);
        await res.body?.cancel();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function presign(method: 'GET' | 'PUT', bucket: string, key: string, ttlSeconds: number, headers: Record<string, string> = {}): Promise<string> {
    const url = new URL(objectUrl(bucket, key));
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(R2_MAX_TTL_SECONDS, Math.floor(ttlSeconds)))));
    // allHeaders: aws4fetch leaves content-type and content-length out of the signature unless asked.
    const signed = await new AwsV4Signer({ ...credentials, method, url: url.toString(), headers, signQuery: true, allHeaders: true }).sign();
    return signed.url.toString();
  }

  async function failure(res: Response, bucket: string, path: string, what: string): Promise<StorageError> {
    const body = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    return new StorageError(bucket, path, `${what}: HTTP ${res.status}${code ? ` ${code}` : ''}`, { notFound: res.status === 404 });
  }

  return {
    provider: 'r2',

    async download(bucket, key) {
      const res = await send('GET', objectUrl(bucket, key));
      if (!res.ok) throw await failure(res, bucket, key, 'download failed');
      return new Uint8Array(await res.arrayBuffer());
    },

    async upload(bucket, key, bytes, contentType) {
      const res = await send('PUT', objectUrl(bucket, key), { headers: { 'Content-Type': contentType }, body: bytes });
      if (!res.ok) throw await failure(res, bucket, key, 'upload failed');
      await res.body?.cancel();
    },

    async exists(bucket, key) {
      const res = await send('HEAD', objectUrl(bucket, key));
      if (res.status === 404) return false;
      if (!res.ok) throw await failure(res, bucket, key, 'head failed');
      return true;
    },

    async remove(bucket, keys) {
      for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
        const part = keys.slice(i, i + DELETE_CHUNK);
        const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${part
          .map((key) => `<Object><Key>${escapeXml(`${bucket}/${key}`)}</Key></Object>`)
          .join('')}</Delete>`;
        const res = await send('POST', `${bucketUrl}?delete`, {
          headers: { 'Content-Type': 'application/xml', 'Content-MD5': createHash('md5').update(xml).digest('base64') },
          body: xml,
        });
        if (!res.ok) throw await failure(res, bucket, part[0] ?? '', 'delete failed');
        // Quiet mode lists only the keys that failed. A key that does not exist is not a failure.
        const body = await res.text();
        const failed = /<Error>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<Code>([^<]*)<\/Code>/.exec(body);
        if (failed) throw new StorageError(bucket, decodeXml(failed[1] ?? ''), `delete failed: ${failed[2] ?? 'error'}`);
      }
    },

    async list(bucket, prefix) {
      const folder = prefix.replace(/\/+$/, '');
      const base = folder ? `${bucket}/${folder}/` : `${bucket}/`;
      const keys: string[] = [];
      let token: string | null = null;
      do {
        const url = new URL(bucketUrl);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', base);
        if (token) url.searchParams.set('continuation-token', token);
        const res = await send('GET', url.toString());
        if (!res.ok) throw await failure(res, bucket, prefix, 'list failed');
        const body = await res.text();
        for (const match of body.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          const key = decodeXml(match[1] ?? '');
          if (key.startsWith(`${bucket}/`)) keys.push(key.slice(bucket.length + 1));
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
        token = truncated ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1] ?? '') || null : null;
      } while (token);
      return keys;
    },

    async signedUrl(bucket, key, ttlSeconds) {
      return presign('GET', bucket, key, ttlSeconds);
    },

    // Content-Type and Content-Length are signed: the upload must have exactly this type and size.
    async signedUpload(bucket, key, { contentType, size, ttlSeconds }): Promise<SignedUpload> {
      const url = await presign('PUT', bucket, key, ttlSeconds, { 'content-type': contentType, 'content-length': String(size) });
      return { method: 'PUT', url, headers: { 'Content-Type': contentType } };
    },
  };
}

/** Encodes each segment of an object key for the URL path (the slashes stay). */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? '';
  });
}
