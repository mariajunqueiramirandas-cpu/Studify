// storage-sign (data-model §7): signed download URLs for stored objects, 1 h. A path the caller may not read
// (or that does not exist, on Supabase Storage) gets null in its place, so a batch never reveals which
// objects exist. The checks are the storage policies (shared/storage-access.ts).
import { StorageSignReqSchema, type StorageSignReq } from '@studify/shared';
import { parseObjectPath } from '@studify/storage';
import { defineFunction } from '../shared/http.ts';
import type { StorageSignRes } from '../shared/responses.ts';
import { canReadObject, type AccessMemo } from '../shared/storage-access.ts';

export const DOWNLOAD_TTL_SECONDS = 3600;

export const handler = defineFunction<StorageSignReq>({
  name: 'storage-sign',
  mutating: false,
  input: StorageSignReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const cache: AccessMemo = new Map();
    const urls = await Promise.all(
      input.paths.map(async (raw) => {
        const path = parseObjectPath(raw);
        if (!path || !(await canReadObject(deps.db, ctx.user.userId, path, cache))) return null;
        return deps.storage.signedUrl(path.bucket, path.key, DOWNLOAD_TTL_SECONDS);
      }),
    );
    const body: StorageSignRes = { urls, expires_at: new Date(ctx.now.getTime() + DOWNLOAD_TTL_SECONDS * 1000).toISOString() };
    return ctx.json(body);
  },
});

export default handler;
