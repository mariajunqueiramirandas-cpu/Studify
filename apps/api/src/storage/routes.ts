// Files over HTTP (ADR 0012, api.md §3.3). The bytes are on the API's disk (FileStore); these routes are the
// student's side of it, with the request/response shapes the app's upload code already spoke to Supabase Storage:
//   GET   /api/storage/object/<bucket>/<name>?token=…   a signed link (signed by storage-sign or the server); Range
//   POST  /api/storage/object/<bucket>/<name>           an upload up to 6 MB (Authorization, x-upsert)
//   POST  /api/storage/upload/resumable                  TUS 1.0.0: create (Upload-Length, Upload-Metadata)
//   HEAD  /api/storage/upload/resumable/<id>             where the upload stands (Upload-Offset)
//   PATCH /api/storage/upload/resumable/<id>             the next chunk; the last one stores the file
// Every upload is authorized by the storage policies, run as the student: the storage.objects row is written as
// `authenticated` with their claims, in the same transaction that moves the file into place. These are binary
// transfers, so they answer plain HTTP; storage-sign, a request for links, answers over SSE like every call.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { ApiFailure, apiError } from '@studify/shared';
import type { Db, FileStore } from '@studify/db';
import { validBucket, validObjectName } from '@studify/db';
import { authenticate, type AuthUser } from '../shared/auth.ts';
import { mapError } from '../shared/errors.ts';
import { CORS_HEADERS, defineFunction, jsonResponse } from '../shared/http.ts';
import type { P2Deps } from '../shared-p2/deps.ts';

const TUS_HEADERS = {
  'Tus-Resumable': '1.0.0',
  'Tus-Version': '1.0.0',
  'Tus-Extension': 'creation',
  'Access-Control-Expose-Headers': 'Location, Upload-Offset, Upload-Length, Tus-Resumable',
};
const UPLOAD_TTL_MS = 24 * 60 * 60_000;
const STORAGE_CORS = {
  ...CORS_HEADERS,
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': `${CORS_HEADERS['Access-Control-Allow-Headers']}, x-upsert, tus-resumable, upload-length, upload-metadata, upload-offset, range`,
};

interface PendingUpload {
  userId: string;
  bucket: string;
  name: string;
  contentType: string;
  cacheControl: string;
  length: number;
  upsert: boolean;
  createdAt: number;
}

function failure(err: unknown): Response {
  const mapped = mapError(err);
  if (mapped.internal) console.error('[storage]', mapped.internal);
  return jsonResponse(mapped.body, mapped.status, STORAGE_CORS);
}

/** A storage.objects write as the student; the policies decide. `dryRun` checks without keeping anything. */
async function writeAsStudent(
  db: Db,
  user: AuthUser,
  row: { bucket: string; name: string; metadata: Record<string, unknown> },
  upsert: boolean,
  inside: () => Promise<void>,
): Promise<void> {
  const student = db.asUser({ sub: user.userId, role: 'authenticated', email: user.email });
  await student.transaction(async (tx) => {
    const objects = tx.schema('storage').from('objects');
    const values = { bucket_id: row.bucket, name: row.name, owner: user.userId, metadata: row.metadata };
    const res = upsert ? await objects.upsert(values, { onConflict: 'bucket_id,name' }) : await objects.insert(values);
    if (res.error) {
      if (res.error.code === '42501') throw new ApiFailure('forbidden', { message: 'Você não pode enviar esse arquivo.' });
      if (res.error.code === '23505') throw new ApiFailure('already_exists');
      throw new Error(`storage.objects: ${res.error.message}`);
    }
    await inside();
  });
}

class DryRun extends Error {}

async function checkWrite(db: Db, user: AuthUser, bucket: string, name: string, upsert: boolean): Promise<void> {
  try {
    await writeAsStudent(db, user, { bucket, name, metadata: {} }, upsert, async () => {
      throw new DryRun();
    });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
}

async function checkRules(files: FileStore, bucket: string, name: string, size: number, contentType: string): Promise<void> {
  const refused = await files.check(bucket, name, size, contentType);
  if (!refused) return;
  if (refused.statusCode === '404') throw new ApiFailure('not_found', { message: 'Esse lugar de arquivos não existe.' });
  if (refused.statusCode === '413') throw new ApiFailure('file_too_large');
  if (refused.statusCode === '415') throw new ApiFailure('invalid_request', { message: 'Esse tipo de arquivo não é aceito aqui.' });
  throw new ApiFailure('invalid_request', { message: 'Nome de arquivo inválido.' });
}

function objectFrom(rest: string): { bucket: string; name: string } {
  const slash = rest.indexOf('/');
  const bucket = slash > 0 ? rest.slice(0, slash) : '';
  let name = '';
  try {
    name = slash > 0 ? rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/') : '';
  } catch {
    name = '';
  }
  if (!validBucket(bucket) || !validObjectName(name)) throw new ApiFailure('invalid_request', { message: 'Nome de arquivo inválido.' });
  return { bucket, name };
}

function decodeMetadata(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ');
    if (key) out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : '';
  }
  return out;
}

async function md5File(file: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** One `bytes=a-b` range of a file of `size` bytes, or null for the whole file; 'invalid' when unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export function mountStorage(app: Hono, deps: P2Deps): void {
  const files = deps.files;
  if (!files) return;
  const uploadsDir = path.join(files.options.root, '.uploads');

  app.options('/api/storage/*', () => new Response(null, { status: 204, headers: STORAGE_CORS }));

  app.get('/api/storage/object/*', async (c) => {
    try {
      const { bucket, name } = objectFrom(c.req.path.slice('/api/storage/object/'.length));
      const grant = files.verify(c.req.query('token') ?? '', bucket, name);
      if (!grant) return jsonResponse(apiError('forbidden', { message: 'Esse link expirou. Abra de novo.' }), 403, STORAGE_CORS);
      const row = await files.object(bucket, name);
      const file = files.filePath(bucket, name);
      const info = row ? await stat(file).catch(() => null) : null;
      if (!row || !info) return jsonResponse(apiError('not_found'), 404, STORAGE_CORS);
      const headers: Record<string, string> = {
        ...STORAGE_CORS,
        'Content-Type': row.metadata?.mimetype ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Accept-Ranges': 'bytes',
        ETag: row.metadata?.eTag ?? `"${info.size}-${info.mtimeMs}"`,
        'X-Content-Type-Options': 'nosniff',
      };
      if (grant.download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(grant.download)}`;
      const range = parseRange(c.req.header('range') ?? null, info.size);
      if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } });
      const body = Bun.file(file);
      if (!range) return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(info.size) } });
      return new Response(body.slice(range.start, range.end + 1), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`, 'Content-Length': String(range.end - range.start + 1) },
      });
    } catch (err) {
      return failure(err);
    }
  });

  const upload = async (req: Request, rest: string): Promise<Response> => {
    try {
      const user = await authenticate(req, deps.db);
      const { bucket, name } = objectFrom(rest);
      const contentType = req.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      const upsert = req.headers.get('x-upsert') === 'true';
      const bytes = new Uint8Array(await req.arrayBuffer());
      await checkRules(files, bucket, name, bytes.byteLength, contentType);
      const staged = await files.stage(bucket, name, bytes);
      try {
        await writeAsStudent(deps.db, user, { bucket, name, metadata: files.metadataOf(bytes, contentType, req.headers.get('cache-control') ?? undefined) }, upsert, () => staged.commit());
      } catch (err) {
        await staged.abort();
        throw err;
      }
      return jsonResponse({ Key: `${bucket}/${name}` }, 200, STORAGE_CORS);
    } catch (err) {
      return failure(err);
    }
  };
  app.post('/api/storage/object/*', (c) => upload(c.req.raw, c.req.path.slice('/api/storage/object/'.length)));
  app.put('/api/storage/object/*', (c) => upload(c.req.raw, c.req.path.slice('/api/storage/object/'.length)));

  const pendingPath = (id: string) => path.join(uploadsDir, `${id}.json`);
  const dataPath = (id: string) => path.join(uploadsDir, `${id}.bin`);
  const readPending = async (id: string, user: AuthUser): Promise<PendingUpload> => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiFailure('not_found');
    const raw = await readFile(pendingPath(id), 'utf8').catch(() => null);
    const pending = raw ? (JSON.parse(raw) as PendingUpload) : null;
    if (!pending || pending.userId !== user.userId) throw new ApiFailure('not_found');
    if (Date.now() - pending.createdAt > UPLOAD_TTL_MS) {
      await Promise.all([rm(pendingPath(id), { force: true }), rm(dataPath(id), { force: true })]);
      throw new ApiFailure('not_found', { message: 'Esse envio expirou. Envie de novo.' });
    }
    return pending;
  };
  const offsetOf = async (id: string): Promise<number> => (await stat(dataPath(id)).catch(() => null))?.size ?? 0;

  app.post('/api/storage/upload/resumable', async (c) => {
    try {
      const user = await authenticate(c.req.raw, deps.db);
      const length = Number(c.req.header('upload-length'));
      if (!Number.isSafeInteger(length) || length <= 0) throw new ApiFailure('invalid_request', { message: 'Upload-Length inválido.' });
      const meta = decodeMetadata(c.req.header('upload-metadata') ?? '');
      const bucket = meta.bucketName ?? '';
      const name = meta.objectName ?? '';
      if (!validBucket(bucket) || !validObjectName(name)) throw new ApiFailure('invalid_request', { message: 'Nome de arquivo inválido.' });
      const contentType = meta.contentType || 'application/octet-stream';
      const upsert = c.req.header('x-upsert') === 'true';
      await checkRules(files, bucket, name, length, contentType);
      await checkWrite(deps.db, user, bucket, name, upsert);
      const id = randomUUID();
      await mkdir(uploadsDir, { recursive: true });
      const pending: PendingUpload = { userId: user.userId, bucket, name, contentType, cacheControl: meta.cacheControl ?? '3600', length, upsert, createdAt: Date.now() };
      await writeFile(dataPath(id), new Uint8Array());
      await writeFile(pendingPath(id), JSON.stringify(pending));
      return new Response(null, { status: 201, headers: { ...STORAGE_CORS, ...TUS_HEADERS, Location: `/api/storage/upload/resumable/${id}`, 'Upload-Offset': '0' } });
    } catch (err) {
      return failure(err);
    }
  });

  // Hono answers HEAD with the GET route (without a body), so HEAD is registered as GET.
  app.get('/api/storage/upload/resumable/:id', async (c) => {
    try {
      const user = await authenticate(c.req.raw, deps.db);
      const pending = await readPending(c.req.param('id'), user);
      return new Response(null, {
        status: 200,
        headers: { ...STORAGE_CORS, ...TUS_HEADERS, 'Upload-Offset': String(await offsetOf(c.req.param('id'))), 'Upload-Length': String(pending.length), 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      return failure(err);
    }
  });

  app.patch('/api/storage/upload/resumable/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const user = await authenticate(c.req.raw, deps.db);
      const pending = await readPending(id, user);
      if (!(c.req.header('content-type') ?? '').startsWith('application/offset+octet-stream')) {
        return new Response(null, { status: 415, headers: { ...STORAGE_CORS, ...TUS_HEADERS } });
      }
      const offset = await offsetOf(id);
      if (Number(c.req.header('upload-offset')) !== offset) {
        return new Response(null, { status: 409, headers: { ...STORAGE_CORS, ...TUS_HEADERS, 'Upload-Offset': String(offset) } });
      }
      const chunk = new Uint8Array(await c.req.arrayBuffer());
      if (offset + chunk.byteLength > pending.length) throw new ApiFailure('invalid_request', { message: 'O envio passou do tamanho anunciado.' });
      await appendFile(dataPath(id), chunk);
      const next = offset + chunk.byteLength;
      if (next === pending.length) {
        const metadata = { size: next, mimetype: pending.contentType, eTag: `"${await md5File(dataPath(id))}"`, cacheControl: `max-age=${pending.cacheControl}` };
        const staged = await files.stageFile(pending.bucket, pending.name, dataPath(id));
        try {
          await writeAsStudent(deps.db, user, { bucket: pending.bucket, name: pending.name, metadata }, pending.upsert, () => staged.commit());
        } catch (err) {
          await staged.abort();
          await rm(pendingPath(id), { force: true });
          throw err;
        }
        await rm(pendingPath(id), { force: true });
      }
      return new Response(null, { status: 204, headers: { ...STORAGE_CORS, ...TUS_HEADERS, 'Upload-Offset': String(next) } });
    } catch (err) {
      return failure(err);
    }
  });
}

const SignInput = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(200),
  expires_in: z.number().int().min(60).max(7 * 24 * 3600).default(3600),
  download: z.union([z.string().min(1).max(200), z.boolean()]).optional(),
});

/**
 * storage-sign: signed links for files the student may read. Only the names the storage policies let them see
 * (storage.objects as `authenticated`) are signed; the others come back with an error. Answered over SSE.
 */
export const storageSign = defineFunction<z.infer<typeof SignInput>>({
  name: 'storage-sign',
  mutating: false,
  readOnly: true,
  input: SignInput,
  run: async (ctx) => {
    const files = (ctx.deps as P2Deps).files;
    if (!files) throw new ApiFailure('internal_error');
    const { bucket, paths, expires_in: expiresIn, download } = ctx.input;
    const valid = paths.filter(validObjectName);
    const visible = await ctx.deps
      .asUser(ctx.user)
      .schema('storage')
      .from('objects')
      .select('name')
      .eq('bucket_id', bucket)
      .in('name', valid);
    if (visible.error) throw new Error(`storage.objects: ${visible.error.message}`);
    const allowed = new Set((visible.data as Array<{ name: string }>).map((r) => r.name));
    return ctx.json({
      urls: paths.map((p) =>
        allowed.has(p) ? { path: p, signedUrl: files.sign(bucket, p, expiresIn, download), error: null } : { path: p, signedUrl: null, error: 'not_found' },
      ),
    });
  },
});
