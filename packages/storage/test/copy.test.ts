import { describe, expect, it } from 'vitest';
import { contentTypeOf, copyAllObjects, StorageError, type ObjectStorage } from '../src/index.ts';

/** An ObjectStorage over a Map of `bucket/key` → { bytes, type }. */
function memoryStorage(seed: Record<string, string> = {}, failDownload = new Set<string>()) {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  for (const [path, text] of Object.entries(seed)) objects.set(path, { bytes: new TextEncoder().encode(text), type: 'seed' });
  const storage: ObjectStorage = {
    provider: 'r2',
    async download(bucket, key) {
      const hit = objects.get(`${bucket}/${key}`);
      if (!hit || failDownload.has(`${bucket}/${key}`)) throw new StorageError(bucket, key, 'missing', { notFound: true });
      return hit.bytes;
    },
    async upload(bucket, key, bytes, type) {
      objects.set(`${bucket}/${key}`, { bytes, type });
    },
    async exists(bucket, key) {
      return objects.has(`${bucket}/${key}`);
    },
    async remove() {},
    async list(bucket, prefix) {
      const base = prefix ? `${bucket}/${prefix}/` : `${bucket}/`;
      return [...objects.keys()].filter((k) => k.startsWith(base)).map((k) => k.slice(bucket.length + 1));
    },
    async signedUrl() {
      return null;
    },
    async signedUpload() {
      throw new Error('not used');
    },
  };
  return { storage, objects };
}

describe('copyAllObjects', () => {
  it('copies every logical bucket with a content type from the extension, skipping what is there', async () => {
    const source = memoryStorage({
      'documents/s/d.pdf': '%PDF-1',
      'page-images/d/thumbs/1.jpg': 'jpg',
      'enem/2023/raw/manifest.json': '{}',
      'audio/answers/u/a.mp3': 'mp3',
      'other/ignored.bin': 'x',
    });
    const target = memoryStorage({ 'documents/s/d.pdf': 'already' });
    const report = await copyAllObjects(source.storage, target.storage);
    expect(report).toEqual({ copied: 3, skipped: 1, bytes: 8, failed: [] });
    expect(new TextDecoder().decode(target.objects.get('documents/s/d.pdf')?.bytes)).toBe('already');
    expect(target.objects.get('page-images/d/thumbs/1.jpg')?.type).toBe('image/jpeg');
    expect(target.objects.get('enem/2023/raw/manifest.json')?.type).toBe('application/json');
    expect(target.objects.get('audio/answers/u/a.mp3')?.type).toBe('audio/mpeg');
    expect(target.objects.has('other/ignored.bin')).toBe(false);
  });

  it('a dry run writes nothing; a failed file is reported and the rest still copy', async () => {
    const source = memoryStorage({ 'photos/u/c/1.jpg': 'a', 'photos/u/c/2.jpg': 'b' }, new Set(['photos/u/c/1.jpg']));
    const target = memoryStorage();
    const seen: string[] = [];
    const dry = await copyAllObjects(source.storage, target.storage, { dryRun: true, onFile: (p, o) => seen.push(`${o} ${p}`) });
    expect(dry.copied).toBe(0);
    expect(target.objects.size).toBe(0);
    expect(seen.sort()).toEqual(['would_copy photos/u/c/1.jpg', 'would_copy photos/u/c/2.jpg']);

    const real = await copyAllObjects(source.storage, target.storage);
    expect(real.copied).toBe(1);
    expect(real.failed.map((f) => f.path)).toEqual(['photos/u/c/1.jpg']);
    expect([...target.objects.keys()]).toEqual(['photos/u/c/2.jpg']);
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeOf('enem/2023/raw/ITENS_PROVA_2023.CSV')).toBe('text/csv');
    expect(contentTypeOf('enem/2023/raw/README')).toBe('application/octet-stream');
  });
});
