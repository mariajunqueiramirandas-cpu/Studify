// Files on the API's disk (ADR 0012). The bytes live under <root>/<bucket>/<name>; each file has a row in
// storage.objects (size, mimetype, eTag), so the storage policies keep deciding who may upload and read, and
// account deletion and purges can find files by prefix. This is db.storage for the server code (service: no
// policy applies) in supabase-js's shapes; the API's storage routes add the student's side (uploads checked by
// the policies, signed download links). A signed link is <publicUrl>/storage/object/<bucket>/<name>?token=…, the
// token an HMAC over bucket, name, expiry and download name.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import type { DbBucket, DbStorage, FileObject, StorageError, StorageResult, UploadOptions } from './storage-types.ts';

type Queryable = Pick<pg.Pool, 'query'>;

export interface FileStorageOptions {
  sql: Queryable;
  /** Directory that holds one folder per bucket (STORAGE_DIR). */
  root: string;
  /** HMAC key for signed links (STORAGE_SIGNING_KEY). */
  signingKey: string;
  /** Public base of the API, e.g. https://studify.vendua.com.br/api. Signed links start with it. */
  publicUrl: string;
}

export interface ObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  metadata: { size?: number; mimetype?: string; eTag?: string; cacheControl?: string } | null;
  created_at: string;
  updated_at: string;
}

export interface SignedTarget {
  bucket: string;
  name: string;
  /** File name for Content-Disposition: attachment, when the link was signed for download. */
  download: string | null;
}

const BUCKET = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A safe object name: relative, no empty, '.' or '..' segment, no backslash or control character. */
export function validObjectName(name: string): boolean {
  if (name.length === 0 || name.length > 1024 || name.startsWith('/')) return false;
  if (/[\\\u0000-\u001f]/.test(name)) return false;
  return name.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

export function validBucket(bucket: string): boolean {
  return BUCKET.test(bucket);
}

function storageError(message: string, statusCode: string): StorageError {
  return { message, statusCode };
}

function fail<T>(message: string, statusCode = '400'): StorageResult<T> {
  return { data: null, error: storageError(message, statusCode) };
}

async function toBytes(body: Uint8Array | ArrayBuffer | Blob | string): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

export class FileStore {
  constructor(readonly options: FileStorageOptions) {}

  filePath(bucket: string, name: string): string {
    return path.join(this.options.root, bucket, ...name.split('/'));
  }

  /** Bucket rules from storage.buckets: size limit and allowed types. Null when the bucket does not exist. */
  async bucket(bucket: string): Promise<{ file_size_limit: number | null; allowed_mime_types: string[] | null } | null> {
    const res = await this.options.sql.query('select file_size_limit, allowed_mime_types from storage.buckets where id = $1', [bucket]);
    const row = res.rows[0] as { file_size_limit: string | number | null; allowed_mime_types: string[] | null } | undefined;
    return row ? { file_size_limit: row.file_size_limit === null ? null : Number(row.file_size_limit), allowed_mime_types: row.allowed_mime_types } : null;
  }

  /** Refuses a file the bucket does not accept; null when it is fine. */
  async check(bucket: string, name: string, size: number, contentType: string): Promise<StorageError | null> {
    if (!validBucket(bucket) || !validObjectName(name)) return storageError('Invalid key', '400');
    const rules = await this.bucket(bucket);
    if (!rules) return storageError('Bucket not found', '404');
    if (rules.file_size_limit !== null && size > rules.file_size_limit) return storageError('The object exceeded the maximum allowed size', '413');
    if (rules.allowed_mime_types && rules.allowed_mime_types.length > 0 && !rules.allowed_mime_types.includes(contentType.split(';')[0]!.trim())) {
      return storageError(`mime type ${contentType} is not supported`, '415');
    }
    return null;
  }

  metadataOf(bytes: Uint8Array, contentType: string, cacheControl?: string): Record<string, unknown> {
    return {
      size: bytes.byteLength,
      mimetype: contentType,
      eTag: `"${createHash('md5').update(bytes).digest('hex')}"`,
      cacheControl: `max-age=${cacheControl ?? '3600'}`,
    };
  }

  /** Writes the bytes next to their final place; `commit` moves them in, `abort` removes them. */
  async stage(bucket: string, name: string, bytes: Uint8Array): Promise<{ commit(): Promise<void>; abort(): Promise<void> }> {
    const final = this.filePath(bucket, name);
    await mkdir(path.dirname(final), { recursive: true });
    const temp = `${final}.${randomUUID()}.part`;
    await writeFile(temp, bytes);
    return {
      commit: () => rename(temp, final),
      abort: () => rm(temp, { force: true }),
    };
  }

  /** Moves an already written file (a finished resumable upload) next to its final place. */
  async stageFile(bucket: string, name: string, source: string): Promise<{ commit(): Promise<void>; abort(): Promise<void> }> {
    const final = this.filePath(bucket, name);
    await mkdir(path.dirname(final), { recursive: true });
    const temp = `${final}.${randomUUID()}.part`;
    await rename(source, temp);
    return {
      commit: () => rename(temp, final),
      abort: () => rm(temp, { force: true }),
    };
  }

  async object(bucket: string, name: string): Promise<ObjectRow | null> {
    const res = await this.options.sql.query(
      `select id, bucket_id, name, metadata, to_json(created_at) #>> '{}' as created_at, to_json(updated_at) #>> '{}' as updated_at
         from storage.objects where bucket_id = $1 and name = $2`,
      [bucket, name],
    );
    return (res.rows[0] as ObjectRow | undefined) ?? null;
  }

  sign(bucket: string, name: string, expiresIn: number, download: string | boolean | undefined): string {
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresIn));
    const dl = download === true ? path.posix.basename(name) : typeof download === 'string' && download ? download : null;
    const payload = Buffer.from(JSON.stringify({ b: bucket, n: name, e: exp, d: dl })).toString('base64url');
    const mac = createHmac('sha256', this.options.signingKey).update(payload).digest('base64url');
    const encoded = name.split('/').map(encodeURIComponent).join('/');
    return `${this.options.publicUrl.replace(/\/+$/, '')}/storage/object/${bucket}/${encoded}?token=${payload}.${mac}`;
  }

  /** The file a signed token grants, or null when it is forged, expired or for another file. */
  verify(token: string, bucket: string, name: string, now: number = Date.now()): SignedTarget | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = createHmac('sha256', this.options.signingKey).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: { b?: unknown; n?: unknown; e?: unknown; d?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (claims.b !== bucket || claims.n !== name || typeof claims.e !== 'number' || claims.e * 1000 < now) return null;
    return { bucket, name, download: typeof claims.d === 'string' ? claims.d : null };
  }

  bucketClient(bucket: string): DbBucket {
    const store = this;
    const sql = this.options.sql;
    return {
      async upload(name, body, options: UploadOptions = {}) {
        try {
          const bytes = await toBytes(body);
          const contentType = options.contentType ?? 'application/octet-stream';
          const refused = await store.check(bucket, name, bytes.byteLength, contentType);
          if (refused) return { data: null, error: refused };
          const staged = await store.stage(bucket, name, bytes);
          try {
            const metadata = JSON.stringify(store.metadataOf(bytes, contentType, options.cacheControl));
            const res = options.upsert
              ? await sql.query(
                  `insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3::jsonb)
                   on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now() returning id`,
                  [bucket, name, metadata],
                )
              : await sql.query(
                  `insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3::jsonb)
                   on conflict (bucket_id, name) do nothing returning id`,
                  [bucket, name, metadata],
                );
            const id = (res.rows[0] as { id: string } | undefined)?.id;
            if (!id) {
              await staged.abort();
              return fail('The resource already exists', '409');
            }
            await staged.commit();
            return { data: { path: name, fullPath: `${bucket}/${name}`, id }, error: null };
          } catch (err) {
            await staged.abort();
            throw err;
          }
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err), '500');
        }
      },

      async download(name) {
        if (!validObjectName(name)) return fail('Invalid key');
        const row = await store.object(bucket, name);
        if (!row) return fail('Object not found', '404');
        try {
          const bytes = await readFile(store.filePath(bucket, name));
          return { data: new Blob([bytes], { type: row.metadata?.mimetype ?? 'application/octet-stream' }), error: null };
        } catch {
          return fail('Object not found', '404');
        }
      },

      async remove(names) {
        const valid = names.filter(validObjectName);
        if (valid.length === 0) return { data: [], error: null };
        const res = await sql.query(
          `delete from storage.objects where bucket_id = $1 and name = any($2::text[])
           returning id, name, metadata, to_json(created_at) #>> '{}' as created_at, to_json(updated_at) #>> '{}' as updated_at`,
          [bucket, valid],
        );
        for (const name of valid) await rm(store.filePath(bucket, name), { force: true });
        return { data: res.rows as FileObject[], error: null };
      },

      async list(prefix = '', options = {}) {
        const base = prefix.replace(/^\/+|\/+$/g, '');
        const like = base === '' ? '%' : `${base.replace(/[\\%_]/g, '\\$&')}/%`;
        const res = await sql.query(
          `select id, name, metadata, to_json(created_at) #>> '{}' as created_at, to_json(updated_at) #>> '{}' as updated_at
             from storage.objects where bucket_id = $1 and name like $2 order by name`,
          [bucket, like],
        );
        // One level at a time, as Supabase Storage lists: files directly under the prefix, and each sub-folder once.
        const out: FileObject[] = [];
        const folders = new Set<string>();
        for (const row of res.rows as Array<FileObject & { name: string }>) {
          const rest = base === '' ? row.name : row.name.slice(base.length + 1);
          const slash = rest.indexOf('/');
          if (slash < 0) out.push({ ...row, name: rest });
          else if (!folders.has(rest.slice(0, slash))) {
            folders.add(rest.slice(0, slash));
            out.push({ name: rest.slice(0, slash), id: null, created_at: null, updated_at: null, metadata: null });
          }
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        const offset = options.offset ?? 0;
        return { data: out.slice(offset, offset + (options.limit ?? 100)), error: null };
      },

      async createSignedUrl(name, expiresIn, options = {}) {
        if (!validObjectName(name)) return fail('Invalid key');
        if (!(await store.object(bucket, name))) return fail('Object not found', '404');
        return { data: { signedUrl: store.sign(bucket, name, expiresIn, options.download) }, error: null };
      },

      async createSignedUrls(names, expiresIn, options = {}) {
        const valid = names.filter(validObjectName);
        const res = await sql.query('select name from storage.objects where bucket_id = $1 and name = any($2::text[])', [bucket, valid]);
        const found = new Set((res.rows as Array<{ name: string }>).map((r) => r.name));
        return {
          data: names.map((name) =>
            found.has(name)
              ? { path: name, signedUrl: store.sign(bucket, name, expiresIn, options.download), error: null }
              : { path: name, signedUrl: null, error: 'Object not found' },
          ),
          error: null,
        };
      },

      async info(name) {
        if (!validObjectName(name)) return fail('Invalid key');
        const row = await store.object(bucket, name);
        if (!row) return fail('Object not found', '404');
        try {
          await stat(store.filePath(bucket, name));
        } catch {
          return fail('Object not found', '404');
        }
        return {
          data: {
            id: row.id,
            name: row.name,
            size: Number(row.metadata?.size ?? 0),
            contentType: row.metadata?.mimetype ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          error: null,
        };
      },
    };
  }

  client(): DbStorage {
    return { from: (bucket: string) => this.bucketClient(bucket) };
  }
}
