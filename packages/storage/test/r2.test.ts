import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isNotFound, r2Storage, StorageError } from '../src/index.ts';
import { verifyPresigned } from './sigv4.ts';

const CONFIG = { accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test-key', bucket: 'studify' };
const HOST = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** A fake S3 endpoint: each request is recorded and answered by `reply` (default 200, empty body). */
function fakeR2(reply: (req: Seen, n: number) => Response | Promise<Response> = () => new Response('')) {
  const seen: Seen[] = [];
  const storage = r2Storage(CONFIG, async (req) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, body: req.body ? await req.text() : '' };
    seen.push(entry);
    return reply(entry, seen.length);
  });
  return { storage, seen };
}

describe('verifyPresigned (test helper)', () => {
  it('accepts the AWS documentation example', () => {
    const url =
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
    expect(verifyPresigned(url, 'GET', {}, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(true);
    expect(verifyPresigned(url, 'GET', {}, 'another-secret')).toBe(false);
  });
});

describe('r2Storage requests', () => {
  it('keeps the logical bucket as the key prefix inside the R2 bucket', async () => {
    const { storage, seen } = fakeR2(() => new Response(new Uint8Array([37, 80, 68, 70])));
    const bytes = await storage.download('documents', 'sub/doc.pdf');
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe(`${HOST}/studify/documents/sub/doc.pdf`);
    expect(seen[0]?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(seen[0]?.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
  });

  it('reports a missing object as not found', async () => {
    const { storage } = fakeR2(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    const err = await storage.download('photos', 'u/1.jpg').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(isNotFound(err)).toBe(true);
    expect((err as Error).message).toContain('NoSuchKey');
  });

  it('uploads with the content type and the bytes', async () => {
    const { storage, seen } = fakeR2();
    await storage.upload('audio', 'subj/ep.mp3', new TextEncoder().encode('mp3!'), 'audio/mpeg');
    expect(seen[0]).toMatchObject({ method: 'PUT', url: `${HOST}/studify/audio/subj/ep.mp3`, body: 'mp3!' });
    expect(seen[0]?.headers.get('content-type')).toBe('audio/mpeg');
  });

  it('answers exists from HEAD', async () => {
    const { storage, seen } = fakeR2((req) => new Response(null, { status: req.url.endsWith('/here.pdf') ? 200 : 404 }));
    expect(await storage.exists('documents', 's/here.pdf')).toBe(true);
    expect(await storage.exists('documents', 's/gone.pdf')).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('retries 5xx answers, then gives up', async () => {
    const flaky = fakeR2((_req, n) => new Response(n < 3 ? 'busy' : 'ok', { status: n < 3 ? 503 : 200 }));
    expect(new TextDecoder().decode(await flaky.storage.download('enem', '2023/1/1.webp'))).toBe('ok');
    expect(flaky.seen).toHaveLength(3);

    const down = fakeR2(() => new Response('down', { status: 500 }));
    await expect(down.storage.download('enem', '2023/1/1.webp')).rejects.toThrow('HTTP 500');
    expect(down.seen).toHaveLength(3);
  });

  it('removes with DeleteObjects in chunks of 1000, escaping the keys', async () => {
    const { storage, seen } = fakeR2();
    const keys = Array.from({ length: 1001 }, (_, i) => `doc/${i}.webp`);
    await storage.remove('page-images', [...keys, 'doc/a&b.json']);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe(`${HOST}/studify?delete`);
    expect(seen[0]?.body.match(/<Object>/g)).toHaveLength(1000);
    expect(seen[0]?.body).toContain('<Key>page-images/doc/0.webp</Key>');
    expect(seen[1]?.body).toContain('<Key>page-images/doc/a&amp;b.json</Key>');
    expect(seen[0]?.headers.get('content-md5')).toBe(createHash('md5').update(seen[0]?.body ?? '').digest('base64'));
  });

  it('removing nothing sends nothing; a per-key error throws', async () => {
    const quiet = fakeR2();
    await quiet.storage.remove('photos', []);
    expect(quiet.seen).toHaveLength(0);

    const failing = fakeR2(() => new Response('<DeleteResult><Error><Key>photos/u/1.jpg</Key><Code>AccessDenied</Code></Error></DeleteResult>'));
    await expect(failing.storage.remove('photos', ['u/1.jpg'])).rejects.toThrow('AccessDenied');
  });

  it('lists every key under a prefix across pages, relative to the bucket', async () => {
    const pages = [
      '<ListBucketResult><Contents><Key>page-images/d1/1.webp</Key></Contents><Contents><Key>page-images/d1/thumbs/1.jpg</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><Contents><Key>page-images/d1/a&amp;b.webp</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
    ];
    const { storage, seen } = fakeR2((_req, n) => new Response(pages[n - 1]));
    expect(await storage.list('page-images', 'd1/')).toEqual(['d1/1.webp', 'd1/thumbs/1.jpg', 'd1/a&b.webp']);
    const first = new URL(seen[0]?.url ?? '');
    expect(first.pathname).toBe('/studify');
    expect(first.searchParams.get('list-type')).toBe('2');
    expect(first.searchParams.get('prefix')).toBe('page-images/d1/');
    expect(new URL(seen[1]?.url ?? '').searchParams.get('continuation-token')).toBe('t&2');
  });

  it('lists a whole logical bucket for an empty prefix', async () => {
    const { storage, seen } = fakeR2(() => new Response('<ListBucketResult><Contents><Key>enem/2023/raw/manifest.json</Key></Contents></ListBucketResult>'));
    expect(await storage.list('enem', '')).toEqual(['2023/raw/manifest.json']);
    expect(new URL(seen[0]?.url ?? '').searchParams.get('prefix')).toBe('enem/');
  });
});

describe('r2Storage presigned URLs', () => {
  const { storage, seen } = fakeR2();

  it('signs downloads locally, without calling R2', async () => {
    const url = await storage.signedUrl('media', 'subj/card/1.webp', 3600);
    expect(url).not.toBeNull();
    const parsed = new URL(url ?? '');
    expect(parsed.origin + parsed.pathname).toBe(`${HOST}/studify/media/subj/card/1.webp`);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(verifyPresigned(url ?? '', 'GET', {}, CONFIG.secretAccessKey)).toBe(true);
    expect(verifyPresigned(url ?? '', 'PUT', {}, CONFIG.secretAccessKey)).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('caps the lifetime at seven days', async () => {
    const url = new URL((await storage.signedUrl('exports', 'u/e.zip', 30 * 24 * 3600)) ?? '');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('signs the content type and the exact size into upload URLs', async () => {
    const upload = await storage.signedUpload('documents', 'subj/doc.pdf', { contentType: 'application/pdf', size: 2048, ttlSeconds: 900 });
    expect(upload.method).toBe('PUT');
    expect(upload.headers).toEqual({ 'Content-Type': 'application/pdf' });
    const url = new URL(upload.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');

    const secret = CONFIG.secretAccessKey;
    expect(verifyPresigned(upload.url, 'PUT', { 'Content-Type': 'application/pdf', 'Content-Length': '2048' }, secret)).toBe(true);
    expect(verifyPresigned(upload.url, 'PUT', { 'Content-Type': 'application/pdf', 'Content-Length': '2049' }, secret)).toBe(false);
    expect(verifyPresigned(upload.url, 'PUT', { 'Content-Type': 'image/png', 'Content-Length': '2048' }, secret)).toBe(false);
    expect(verifyPresigned(upload.url, 'PUT', { 'Content-Type': 'application/pdf' }, secret)).toBe(false);
  });

  it('honours a custom endpoint', async () => {
    const eu = r2Storage({ ...CONFIG, endpoint: 'https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com/' });
    const url = new URL((await eu.signedUrl('avatars', 'u.webp', 60)) ?? '');
    expect(url.host).toBe('0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/studify/avatars/u.webp');
  });
});
