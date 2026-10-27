// storage-upload (data-model §7): signs the URL the app uploads one file to. The app never writes to storage
// with its own credentials: R2 has none to give it, so every upload starts here. The checks are the storage
// policies (shared/storage-access.ts) plus the bucket's type and size limits; R2 also signs the size and type,
// so the upload itself cannot change them.
import { ApiFailure, StorageUploadReqSchema, type StorageUploadReq } from '@studify/shared';
import { BUCKETS, parseObjectPath } from '@studify/storage';
import { defineFunction } from '../shared/http.ts';
import type { StorageUploadRes } from '../shared/responses.ts';
import { canWriteObject, WRITE_ONCE } from '../shared/storage-access.ts';

/** Long enough for a 100 MB PDF on a slow connection; R2 checks the expiry when the upload starts. */
export const UPLOAD_TTL_SECONDS = 3600;

export const handler = defineFunction<StorageUploadReq>({
  name: 'storage-upload',
  mutating: false,
  input: StorageUploadReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const path = parseObjectPath(input.path);
    if (!path) throw new ApiFailure('invalid_request', { message: 'Caminho de arquivo inválido.' });
    const rule = BUCKETS[path.bucket];
    const contentType = input.content_type.trim().toLowerCase();
    if (!(rule.mimeTypes as readonly string[]).includes(contentType)) {
      throw new ApiFailure('invalid_request', { message: 'Esse tipo de arquivo não é aceito aqui.' });
    }
    if (input.size > rule.maxBytes) {
      throw new ApiFailure('file_too_large', { message: `Esse arquivo é grande demais (máx. ${Math.round(rule.maxBytes / (1024 * 1024))} MB).` });
    }
    // One answer for "no such subject" and "not yours", so a path never reveals what exists (api §2.2).
    if (!(await canWriteObject(deps.db, ctx.user.userId, path))) throw new ApiFailure('forbidden');
    if (WRITE_ONCE.has(path.bucket) && (await deps.storage.exists(path.bucket, path.key))) {
      throw new ApiFailure('already_exists', { message: 'Esse arquivo já foi enviado.' });
    }

    const signed = await deps.storage.signedUpload(path.bucket, path.key, { contentType, size: input.size, ttlSeconds: UPLOAD_TTL_SECONDS });
    const body: StorageUploadRes = {
      method: signed.method,
      url: signed.url,
      headers: signed.headers,
      expires_at: new Date(ctx.now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
    return ctx.json(body);
  },
});

export default handler;
