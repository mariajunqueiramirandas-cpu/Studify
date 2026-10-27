// Copies every stored file of the logical buckets from one backend to another (Supabase Storage → R2 when a
// deployment moves its files, deployment.md §9). Keys already in the target are skipped, so a second run
// after the switch only picks up what was uploaded in between.
import { BUCKETS } from './buckets.ts';
import type { ObjectStorage } from './types.ts';

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  json: 'application/json',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  zip: 'application/zip',
  csv: 'text/csv',
  txt: 'text/plain',
};

export function contentTypeOf(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export interface CopyReport {
  copied: number;
  skipped: number;
  bytes: number;
  failed: Array<{ path: string; error: string }>;
}

export interface CopyOptions {
  /** List what would be copied, write nothing. */
  dryRun?: boolean;
  /** Files copied at once. Default 4. */
  concurrency?: number;
  onFile?: (path: string, outcome: 'copied' | 'skipped' | 'failed' | 'would_copy') => void;
}

export async function copyAllObjects(source: ObjectStorage, target: ObjectStorage, options: CopyOptions = {}): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, skipped: 0, bytes: 0, failed: [] };
  for (const bucket of Object.keys(BUCKETS)) {
    const keys = await source.list(bucket, '');
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++] as string;
        const path = `${bucket}/${key}`;
        try {
          if (await target.exists(bucket, key)) {
            report.skipped++;
            options.onFile?.(path, 'skipped');
            continue;
          }
          if (options.dryRun) {
            options.onFile?.(path, 'would_copy');
            continue;
          }
          const bytes = await source.download(bucket, key);
          await target.upload(bucket, key, bytes, contentTypeOf(key));
          report.copied++;
          report.bytes += bytes.byteLength;
          options.onFile?.(path, 'copied');
        } catch (err) {
          report.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
          options.onFile?.(path, 'failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  }
  return report;
}
