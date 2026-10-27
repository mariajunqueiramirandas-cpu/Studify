// ingest.photos_to_pdf (ING-01 photo material, CAM-01): decodes the uploaded photos, strips metadata by
// re-encoding (EXIF, GPS), downsizes to 1600 px on the long edge, and builds one PDF. The PDF then goes through
// the normal document pipeline (ingest.document). Face blur (ING-01) is not implemented here.
import { createHash } from 'node:crypto';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import type { JobContext } from '../framework/types.ts';
import { PermanentJobError } from '../framework/errors.ts';
import { BUCKET, type ObjectStore } from './store.ts';
import { buildPhotoPdf } from './pdf-build.ts';
import { loadDocument, patchDocument } from './repo.ts';

export const PHOTO_LONG_EDGE_PX = 1600;

export interface PhotoPayload {
  subjectId: string;
  documentId: string;
  imagePaths: string[];
  userId: string | null;
  aiJobId: string | null;
}

/** Decodes one photo and returns an EXIF-free JPEG at most 1600 px on the long edge. */
export async function normalizePhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  let image;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch {
    throw new PermanentJobError('photo_unreadable', 'photo could not be decoded');
  }
  const scale = Math.min(1, PHOTO_LONG_EDGE_PX / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const jpeg = await canvas.encode('jpeg', 85);
  return { bytes: new Uint8Array(jpeg), width, height };
}

export async function runPhotosToPdf(ctx: JobContext, store: ObjectStore, payload: PhotoPayload): Promise<void> {
  const doc = await loadDocument(ctx.db, payload.documentId);
  if (!doc || doc.deleted) return;
  const images: Array<{ bytes: Uint8Array; width: number; height: number }> = [];
  for (const path of payload.imagePaths) {
    const raw = await store.download(BUCKET.photos, path);
    images.push(await normalizePhoto(raw));
  }
  if (images.length === 0) throw new PermanentJobError('photo_unreadable', 'no photos');

  const pdf = await buildPhotoPdf(images);
  const storagePath = `${doc.subjectId}/${doc.id}.pdf`;
  await store.upload(BUCKET.documents, storagePath, pdf, 'application/pdf');
  const checksum = createHash('sha256').update(pdf).digest('hex');
  await patchDocument(ctx.db, doc.id, {
    storagePath,
    sizeBytes: pdf.byteLength,
    checksum,
    pageCount: images.length,
    status: 'uploaded',
  }).catch((err: unknown) => {
    const code = (err as { code?: string }).code;
    if (code === '23505') throw new PermanentJobError('already_exists', 'duplicate document checksum in subject');
    throw err;
  });
  await ctx.enqueue('ingest.document', { document_id: doc.id, mode: 'full', user_id: payload.userId, ai_job_id: payload.aiJobId }, {
    singletonKey: `ingest:${doc.id}`,
  });
}
