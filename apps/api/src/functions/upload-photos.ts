// upload-photos (ING-01 photo material, CAM-01). The app uploads the photos to photos/{user}/… first. This
// function checks the paths belong to the caller, creates the documents row (kind photo) and queues the
// worker job that builds the PDF (EXIF strip, face blur, HEIC→JPEG: worker side, api §7).
import type { z } from 'zod';
import { ApiFailure, UploadPhotosReqSchema, } from '@studify/shared';
import type { UploadPhotosRes } from '../shared/responses.ts';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { objectExists } from '../shared/storage.ts';
import { createAiJob } from '../shared/jobs.ts';
import { hashBody } from '../shared/idempotency.ts';

export const MAX_PHOTOS = 25;

export const handler = defineFunction<z.infer<typeof UploadPhotosReqSchema>>({
  name: 'upload-photos',
  mutating: true,
  input: UploadPhotosReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    if (input.image_paths.length > MAX_PHOTOS) throw new ApiFailure('invalid_request', { message: `Envia no máximo ${MAX_PHOTOS} fotos de uma vez.` });
    const subject = await requireSubject(deps.db, userId, input.subject_id, 'upload');

    const ownPrefix = `photos/${userId}/`;
    for (const path of input.image_paths) {
      if (!path.startsWith(ownPrefix)) throw new ApiFailure('forbidden');
      if (!(await objectExists(deps.db, path))) throw new ApiFailure('not_found', { message: 'Uma das fotos não chegou no servidor. Tenta de novo.' });
    }

    const documentId = deps.newId();
    // Placeholder checksum and size until the worker writes the PDF; both satisfy the table checks.
    const checksum = await hashBody([...input.image_paths].sort().join('\n'));
    const inserted = await deps.db.from('documents').insert({
      id: documentId,
      subject_id: subject.id,
      uploaded_by: userId,
      title: `Fotos de ${ctx.now.toISOString().slice(0, 10)}`,
      kind: 'photo',
      storage_path: `documents/${subject.id}/${documentId}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: 1,
      checksum_sha256: checksum,
      status: 'processing',
    });
    if (inserted.error) throw inserted.error;

    const jobId = await createAiJob(deps, { type: 'ingest.photos_to_pdf', userId, subjectId: subject.id, documentId, stage: 'photos' });
    await deps.enqueue('ingest.photos_to_pdf', { subject_id: subject.id, image_paths: input.image_paths, document_id: documentId, ai_job_id: jobId }, { retryLimit: 3 });

    const body: UploadPhotosRes = { document_id: documentId, job_id: jobId };
    return ctx.json(body, 202);
  },
});

export default handler;
