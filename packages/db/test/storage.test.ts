// The file store against a real, migrated Postgres and a temporary directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore, validObjectName } from '../src/storage.ts';
import { adminUrl, createScratch, type Scratch } from './support/scratch.ts';

describe('object names', () => {
  it('refuses paths that could leave the bucket folder', () => {
    expect(validObjectName('a/b/c.pdf')).toBe(true);
    for (const bad of ['', '/a', 'a//b', '../x', 'a/../b', 'a/./b', 'a\\b', 'a\u0000b']) expect(validObjectName(bad)).toBe(false);
  });
});

describe('signed links', () => {
  const store = new FileStore({ sql: { query: async () => ({ rows: [] }) } as never, root: '/tmp/none', signingKey: 'k'.repeat(32), publicUrl: 'https://studify.test/api/' });
  it('grant one file until they expire, and nothing else', () => {
    const url = new URL(store.sign('documents', 'sub/doc 1.pdf', 60, 'meus-dados.zip'));
    expect(url.pathname).toBe('/api/storage/object/documents/sub/doc%201.pdf');
    const token = url.searchParams.get('token')!;
    expect(store.verify(token, 'documents', 'sub/doc 1.pdf')).toEqual({ bucket: 'documents', name: 'sub/doc 1.pdf', download: 'meus-dados.zip' });
    expect(store.verify(token, 'documents', 'sub/other.pdf')).toBeNull();
    expect(store.verify(token, 'photos', 'sub/doc 1.pdf')).toBeNull();
    expect(store.verify(token, 'documents', 'sub/doc 1.pdf', Date.now() + 120_000)).toBeNull();
    expect(store.verify(`${token.split('.')[0]}.forged`, 'documents', 'sub/doc 1.pdf')).toBeNull();
  });
});

describe.skipIf(!adminUrl)('file store against Postgres', () => {
  let scratch: Scratch;
  let store: FileStore;
  const root = mkdtempSync(path.join(tmpdir(), 'studify-files-'));

  beforeAll(async () => {
    scratch = await createScratch('storage');
    store = new FileStore({ sql: scratch.pool, root, signingKey: 's'.repeat(32), publicUrl: 'https://studify.test/api' });
  });
  afterAll(async () => { await scratch?.drop(); });

  it('uploads, reads, lists, signs and removes like supabase-js', async () => {
    const bucket = store.client().from('exports');
    const up = await bucket.upload('u1/e1.zip', new Uint8Array([1, 2, 3]), { contentType: 'application/zip' });
    expect(up.error).toBeNull();
    expect(up.data?.path).toBe('u1/e1.zip');
    expect(await readFile(path.join(root, 'exports', 'u1', 'e1.zip'))).toEqual(Buffer.from([1, 2, 3]));
    expect((await bucket.upload('u1/e1.zip', new Uint8Array([4]), { contentType: 'application/zip' })).error?.statusCode).toBe('409');
    expect((await bucket.upload('u1/e1.zip', new Uint8Array([4, 5]), { contentType: 'application/zip', upsert: true })).error).toBeNull();
    const down = await bucket.download('u1/e1.zip');
    expect(new Uint8Array(await down.data!.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
    expect((await bucket.info('u1/e1.zip')).data).toMatchObject({ size: 2, contentType: 'application/zip' });

    await bucket.upload('u1/sub/e2.zip', new Uint8Array([9]), { contentType: 'application/zip' });
    const listed = await bucket.list('u1', { limit: 1000 });
    expect(listed.data!.map((e) => [e.name, e.id === null])).toEqual([['e1.zip', false], ['sub', true]]);

    const signed = await bucket.createSignedUrl('u1/e1.zip', 60, { download: 'meus-dados.zip' });
    expect(signed.data!.signedUrl).toContain('https://studify.test/api/storage/object/exports/u1/e1.zip?token=');
    expect((await bucket.createSignedUrl('u1/nope.zip', 60)).error?.statusCode).toBe('404');

    const removed = await bucket.remove(['u1/e1.zip', 'u1/sub/e2.zip']);
    expect(removed.data!.map((r) => r.name).sort()).toEqual(['u1/e1.zip', 'u1/sub/e2.zip']);
    expect((await bucket.download('u1/e1.zip')).error?.statusCode).toBe('404');
  });

  it('applies the bucket rules', async () => {
    expect((await store.client().from('photos').upload('u/x.gif', new Uint8Array([1]), { contentType: 'image/gif' })).error?.statusCode).toBe('415');
    expect((await store.client().from('avatars').upload('u.webp', new Uint8Array(2 * 1024 * 1024), { contentType: 'image/webp' })).error?.statusCode).toBe('413');
    expect((await store.client().from('nope').upload('a', new Uint8Array([1]))).error?.statusCode).toBe('404');
    expect((await store.client().from('exports').upload('../escape', new Uint8Array([1]))).error?.statusCode).toBe('400');
  });
});
