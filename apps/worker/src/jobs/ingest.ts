// Ingestion jobs (api.md §7): document pipeline entry points, render and transcription, photos to PDF.
import { z } from 'zod';
import type { JobDefinition, JobContext } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { supabaseStore } from '../ingest/store.ts';
import { runIngestDocument, runRenderPages, runTranscription } from '../ingest/pipeline.ts';
import { runPhotosToPdf } from '../ingest/photos.ts';

const uuid = z.uuid();
const optionalUuid = uuid.nullable().default(null);
const aiJobId = uuid.nullable().optional().transform((v) => v ?? null);

const DocumentPayload = z.object({
  document_id: uuid,
  mode: z.enum(['full', 'outline_only', 'resume', 'merge']).default('full'),
  user_id: optionalUuid,
  ai_job_id: aiJobId,
});

const RenderPayload = z.object({ document_id: uuid, user_id: optionalUuid, ai_job_id: aiJobId });

const TranscribePayload = z.object({
  document_id: uuid,
  pages: z.array(z.number().int().min(1)).max(1000).default([]),
  user_id: optionalUuid,
  ai_job_id: aiJobId,
});

const PhotoPayload = z.object({
  subject_id: uuid,
  document_id: uuid,
  image_paths: z.array(z.string().min(3).max(512)).min(1).max(40),
  user_id: optionalUuid,
  ai_job_id: aiJobId,
});

const store = (ctx: JobContext) => supabaseStore(ctx.supabase);

export const jobs: JobDefinition<any>[] = [
  {
    name: 'ingest.document',
    retryLimit: 3,
    retryBackoff: true,
    expireInSeconds: 2 * 3600,
    concurrency: 2,
    handler: async (ctx, data, meta) => {
      const p = parsePayload(DocumentPayload, data, 'ingest.document');
      await runIngestDocument(ctx, store(ctx), {
        documentId: p.document_id,
        mode: p.mode,
        userId: p.user_id,
        aiJobId: p.ai_job_id ?? meta.aiJobId,
      });
    },
  },
  {
    // Same pipeline as ingest.document when the subject already has a map: S1 takes the merge path (ING-03.9).
    name: 'ingest.merge',
    retryLimit: 3,
    retryBackoff: true,
    expireInSeconds: 2 * 3600,
    concurrency: 2,
    handler: async (ctx, data, meta) => {
      const p = parsePayload(DocumentPayload, data, 'ingest.merge');
      await runIngestDocument(ctx, store(ctx), {
        documentId: p.document_id,
        mode: 'merge',
        userId: p.user_id,
        aiJobId: p.ai_job_id ?? meta.aiJobId,
      });
    },
  },
  {
    name: 'ingest.render_pages',
    retryLimit: 2,
    expireInSeconds: 3600,
    concurrency: 1,
    handler: async (ctx, data, meta) => {
      const p = parsePayload(RenderPayload, data, 'ingest.render_pages');
      const rendered = await runRenderPages(ctx, store(ctx), p.document_id);
      ctx.log.info({ rendered }, 'pages rendered');
    },
  },
  {
    name: 'ingest.transcribe_pages',
    retryLimit: 3,
    expireInSeconds: 3600,
    handler: async (ctx, data, meta) => {
      const p = parsePayload(TranscribePayload, data, 'ingest.transcribe_pages');
      await runTranscription(ctx, store(ctx), {
        documentId: p.document_id,
        pages: p.pages,
        userId: p.user_id,
        aiJobId: p.ai_job_id ?? meta.aiJobId,
      });
    },
  },
  {
    name: 'ingest.photos_to_pdf',
    retryLimit: 3,
    expireInSeconds: 1800,
    handler: async (ctx, data, meta) => {
      const p = parsePayload(PhotoPayload, data, 'ingest.photos_to_pdf');
      await runPhotosToPdf(ctx, store(ctx), {
        subjectId: p.subject_id,
        documentId: p.document_id,
        imagePaths: p.image_paths,
        userId: p.user_id,
        aiJobId: p.ai_job_id ?? meta.aiJobId,
      });
    },
  },
];
