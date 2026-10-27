import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { BUCKETS, isNotFound, parseObjectPath, storageConfigFromEnv, StorageConfigError, supabaseStorage } from '../src/index.ts';

/** The supabase-js storage surface over a Map of `bucket/key` → bytes, listing like Supabase (one level). */
function fakeSupabase() {
  const objects = new Map<string, Uint8Array>();
  const calls: Array<{ op: string; bucket: string; arg: unknown }> = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        download: async (key: string) => {
          const bytes = objects.get(`${bucket}/${key}`);
          return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: 'Object not found' } };
        },
        upload: async (key: string, bytes: Uint8Array, options: unknown) => {
          calls.push({ op: 'upload', bucket, arg: options });
          objects.set(`${bucket}/${key}`, bytes);
          return { data: { path: key }, error: null };
        },
        info: async (key: string) => (objects.has(`${bucket}/${key}`) ? { data: {}, error: null } : { data: null, error: { message: 'Object not found' } }),
        remove: async (keys: string[]) => {
          calls.push({ op: 'remove', bucket, arg: keys.length });
          for (const key of keys) objects.delete(`${bucket}/${key}`);
          return { data: [], error: null };
        },
        list: async (folder: string) => {
          const base = folder ? `${bucket}/${folder}/` : `${bucket}/`;
          const entries = new Map<string, { name: string; id: string | null }>();
          for (const key of objects.keys()) {
            if (!key.startsWith(base)) continue;
            const rest = key.slice(base.length);
            const slash = rest.indexOf('/');
            const name = slash === -1 ? rest : rest.slice(0, slash);
            entries.set(name, { name, id: slash === -1 ? `id-${name}` : null });
          }
          return { data: [...entries.values()], error: null };
        },
        createSignedUrl: async (key: string, ttl: number) =>
          objects.has(`${bucket}/${key}`) ? { data: { signedUrl: `https://sb.test/sign/${bucket}/${key}?ttl=${ttl}` }, error: null } : { data: null, error: { message: 'Object not found' } },
        createSignedUploadUrl: async (key: string, options: { upsert?: boolean }) => ({
          data: { signedUrl: `https://sb.test/upload/sign/${bucket}/${key}?token=t&upsert=${options.upsert}`, token: 't', path: key },
          error: null,
        }),
      }),
    },
  };
  return { storage: supabaseStorage(client as unknown as SupabaseClient), objects, calls };
}

describe('supabaseStorage', () => {
  it('round-trips bytes and reports missing objects as not found', async () => {
    const { storage, calls } = fakeSupabase();
    await storage.upload('photos', 'u/c/1.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect(calls[0]?.arg).toEqual({ contentType: 'image/jpeg', upsert: true });
    expect([...(await storage.download('photos', 'u/c/1.jpg'))]).toEqual([1, 2, 3]);
    expect(await storage.exists('photos', 'u/c/1.jpg')).toBe(true);
    expect(await storage.exists('photos', 'u/c/2.jpg')).toBe(false);
    expect(isNotFound(await storage.download('photos', 'u/c/2.jpg').catch((e: unknown) => e))).toBe(true);
  });

  it('lists sub-folders recursively and removes in chunks of 100', async () => {
    const { storage, objects, calls } = fakeSupabase();
    for (let i = 0; i < 150; i++) objects.set(`page-images/d1/${i}.webp`, new Uint8Array());
    objects.set('page-images/d1/thumbs/1.jpg', new Uint8Array());
    objects.set('page-images/d2/1.webp', new Uint8Array());
    const keys = await storage.list('page-images', 'd1');
    expect(keys).toHaveLength(151);
    expect(keys).toContain('d1/thumbs/1.jpg');
    await storage.remove('page-images', keys);
    expect(calls.filter((c) => c.op === 'remove').map((c) => c.arg)).toEqual([100, 51]);
    expect([...objects.keys()]).toEqual(['page-images/d2/1.webp']);
  });

  it('lists a whole bucket for an empty prefix', async () => {
    const { storage, objects } = fakeSupabase();
    objects.set('enem/2023/raw/manifest.json', new Uint8Array());
    objects.set('enem/2023/1/1.webp', new Uint8Array());
    expect((await storage.list('enem', '')).sort()).toEqual(['2023/1/1.webp', '2023/raw/manifest.json']);
  });

  it('signs downloads (null when missing) and upserting uploads', async () => {
    const { storage, objects } = fakeSupabase();
    objects.set('audio/s/e.mp3', new Uint8Array());
    expect(await storage.signedUrl('audio', 's/e.mp3', 3600)).toBe('https://sb.test/sign/audio/s/e.mp3?ttl=3600');
    expect(await storage.signedUrl('audio', 's/none.mp3', 3600)).toBeNull();
    expect(await storage.signedUpload('documents', 's/d.pdf', { contentType: 'application/pdf', size: 10, ttlSeconds: 900 })).toEqual({
      method: 'PUT',
      url: 'https://sb.test/upload/sign/documents/s/d.pdf?token=t&upsert=true',
      headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    });
  });
});

describe('storageConfigFromEnv', () => {
  const r2 = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'studify' };

  it('uses Supabase Storage until R2 is configured', () => {
    expect(storageConfigFromEnv({})).toEqual({ provider: 'supabase' });
    expect(storageConfigFromEnv({ ...r2, STORAGE_PROVIDER: 'supabase' })).toEqual({ provider: 'supabase' });
  });

  it('switches to R2 when R2_BUCKET is set', () => {
    expect(storageConfigFromEnv({ ...r2, R2_ENDPOINT: ' ' })).toEqual({
      provider: 'r2',
      r2: { accountId: r2.R2_ACCOUNT_ID, accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'studify' },
    });
  });

  it('lists every missing or malformed variable', () => {
    const err = (() => {
      try {
        storageConfigFromEnv({ STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'not-an-id' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StorageConfigError);
    expect((err as StorageConfigError).problems).toEqual([
      'R2_ACCESS_KEY_ID is missing (STORAGE_PROVIDER=r2)',
      'R2_SECRET_ACCESS_KEY is missing (STORAGE_PROVIDER=r2)',
      'R2_BUCKET is missing (STORAGE_PROVIDER=r2)',
      'R2_ACCOUNT_ID must be the 32-character account id',
    ]);
    expect(() => storageConfigFromEnv({ STORAGE_PROVIDER: 's3' })).toThrow('STORAGE_PROVIDER must be r2 or supabase');
  });
});

describe('parseObjectPath', () => {
  it('splits known buckets into key and segments', () => {
    expect(parseObjectPath('documents/5a00/d0c0.pdf')).toEqual({ bucket: 'documents', key: '5a00/d0c0.pdf', segments: ['5a00', 'd0c0.pdf'] });
    expect(parseObjectPath('audio/answers/u1/i1.mp3')?.segments).toEqual(['answers', 'u1', 'i1.mp3']);
  });

  it('refuses unknown buckets and anything that is not a plain name', () => {
    for (const bad of ['', 'documents', 'documents/', 'nope/a.pdf', 'documents/../x.pdf', 'documents/a//b.pdf', 'documents/.hidden', 'documents/a b.pdf', '/documents/a.pdf', 'constructor/a']) {
      expect(parseObjectPath(bad)).toBeNull();
    }
  });

  it('mirrors the bucket limits of the storage migration', () => {
    expect(BUCKETS.documents.maxBytes).toBe(104857600);
    expect(BUCKETS.photos.maxBytes).toBe(15728640);
    expect(BUCKETS.avatars.maxBytes).toBe(1048576);
    expect(Object.keys(BUCKETS)).toHaveLength(10);
  });
});
