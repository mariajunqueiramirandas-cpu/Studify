// Ingestion state machine (spec 01 §8.2). Each entry point reads the database to decide which stage is
// still missing, so a retried or resumed job continues where it stopped and never repeats a finished stage:
//   S0 preflight + text layer + spans  -> S1 outline (standard API)  -> S2 concepts (Batch)
//   -> S3 prerequisites (standard) and S4 content (Batch: notes, glossary, cards, questions) -> ready.
// Budget refusals park the document as waiting_budget and re-enqueue the same job for the next local midnight.
import { BudgetExceededError } from '@studify/ai';
import type { JobContext } from '../framework/types.ts';
import { tableExists, type Sql } from '../framework/db.ts';
import { applyProgress } from '../framework/progress.ts';
import { PermanentJobError } from '../framework/errors.ts';
import { nextLocalMidnight, zonedToInstant } from '../framework/timeutil.ts';
import { createEnv, type PipelineEnv } from './env.ts';
import { BUCKET, keys, type ObjectStore } from './store.ts';
import { preflightPdf, readBookmarkStarts } from './pdf-preflight.ts';
import { extractPages, type PageExtraction } from './pdf-text.ts';
import { renderPages } from './pdf-render.ts';
import { spansFile } from './pdf-spans.ts';
import { writeOutline, runOutlineCalls } from './outline.ts';
import { runPrerequisites } from './prereq.ts';
import { topicItem, submitWave, transcriptionItem, transcriptionRuns, type PollOutcomeSummary, type WavePlan } from './waves.ts';
import { loadTopicBundle, sourcesOf, topicSliceRefs, contentLanguageOf, isQuantitativeTopic, type TopicBundle } from './topics.ts';
import { expandKinds, type TopicKind } from './custom-id.ts';
import { listNodes, documentHasNodes, documentHasPages, loadDocument, nodeSourcesOfDocument, patchDocument, setContentStatus, setPageAssets, upsertPages, scannedPages, topicsWithConcepts, type DocumentRecord, type PageRecord, loadSubject } from './repo.ts';
import { MAX_UPLOAD_BYTES, MAX_PAGES } from './limits.ts';
import { mapLimit } from './concurrency.ts';
import { uuidV7 } from '@studify/shared';

export const FAILURE_BODY: Readonly<Record<string, string>> = {
  password_protected: 'Esse PDF tem senha. Tira a senha e envia de novo.',
  corrupt: 'Não consegui abrir esse arquivo. Ele pode estar corrompido — tenta baixar de novo.',
  too_large: 'Esse arquivo é grande demais (máx. 100 MB). Tenta dividir em partes.',
  too_many_pages: 'Esse PDF tem mais de 1.000 páginas. Envia só os capítulos que você precisa.',
  empty: 'Não encontrei páginas nesse arquivo.',
  unsupported_type: 'Esse arquivo não é um PDF.',
  not_study_material: 'Hmm, isso não parece material de estudo. Quer usar mesmo assim?',
  ai_failed: 'Algo deu errado ao ler o material. Tenta de novo.',
  ai_refused: 'Não consegui processar essa parte do material. Tenta de novo.',
};

export interface IngestPayload {
  documentId: string;
  mode: 'full' | 'outline_only' | 'resume' | 'merge';
  userId: string | null;
  aiJobId: string | null;
}

interface Stage {
  env: PipelineEnv;
  ctx: JobContext;
  sql: Sql;
  store: ObjectStore;
}

function stageOf(ctx: JobContext, store: ObjectStore): Stage {
  const env = createEnv(ctx, store);
  return { env, ctx, sql: ctx.db, store };
}

/** Sends the processing-channel push for a finished or failed document (PLT-05.4: not counted). */
async function notifyDocument(stage: Stage, doc: DocumentRecord, userId: string | null, outcome: 'ready' | 'failed', errorCode?: string | null) {
  const target = userId ?? doc.uploadedBy;
  if (!target) return;
  const subject = doc.subjectName;
  const data = { subject_id: doc.subjectId, document_id: doc.id };
  if (outcome === 'ready') {
    await stage.ctx.push(target, {
      channel: 'processing',
      title: 'Material pronto',
      body: `Seu material de ${subject} está pronto 📚`,
      data: { ...data, type: 'material_ready', deep_link: `studify://subjects/${doc.subjectId}` },
      requested: true,
    });
  } else {
    await stage.ctx.push(target, {
      channel: 'processing',
      title: 'Não consegui processar seu material',
      body: FAILURE_BODY[errorCode ?? 'ai_failed'] ?? FAILURE_BODY.ai_failed as string,
      data: { ...data, type: 'material_failed', deep_link: `studify://subjects/${doc.subjectId}/document/${doc.id}` },
      requested: true,
    });
  }
}

async function failDocument(stage: Stage, doc: DocumentRecord, code: string, userId: string | null, aiJobId: string | null): Promise<void> {
  await patchDocument(stage.sql, doc.id, { status: 'failed', errorCode: code });
  if (aiJobId) await applyProgress(stage.sql, aiJobId, { status: 'failed', error_code: code });
  await notifyDocument(stage, doc, userId, 'failed', code);
}

/** Parks the document until the budget resets (ai-pipeline §9.1, spec 01 §9). */
async function parkForBudget(stage: Stage, doc: DocumentRecord, payload: IngestPayload, resetsAt: string | undefined): Promise<void> {
  await patchDocument(stage.sql, doc.id, { status: 'waiting_budget' });
  if (payload.aiJobId) await applyProgress(stage.sql, payload.aiJobId, { status: 'waiting_budget' });
  const tz = await timezoneOf(stage.sql, payload.userId ?? doc.uploadedBy);
  const when = resetsAt ? localMidnightOn(resetsAt, tz) : nextLocalMidnight(stage.ctx.now(), tz);
  await stage.ctx.enqueue(
    'ingest.document',
    { document_id: doc.id, mode: 'resume', user_id: payload.userId, ai_job_id: payload.aiJobId },
    { startAfter: when, singletonKey: `ingest:${doc.id}:resume` },
  );
}

/** 00:05 on the local date `resets_at` (the budget period boundary, PLT-04) in the user's time zone. */
function localMidnightOn(resetsAt: string, timeZone: string): Date {
  const [y, m, d] = resetsAt.split('-').map(Number) as [number, number, number];
  return zonedToInstant(y, m, d, 0, 5, timeZone);
}

export async function timezoneOf(sql: Sql, userId: string | null): Promise<string> {
  if (!userId) return 'America/Sao_Paulo';
  const { rows } = await sql.query<{ timezone: string }>(`select timezone from public.profiles where id = $1`, [userId]);
  return rows[0]?.timezone ?? 'America/Sao_Paulo';
}

// ---------------------------------------------------------------------------
// ingest.document / ingest.merge
// ---------------------------------------------------------------------------

export async function runIngestDocument(ctx: JobContext, store: ObjectStore, payload: IngestPayload): Promise<void> {
  const stage = stageOf(ctx, store);
  const { env, sql } = stage;
  const doc = await loadDocument(sql, payload.documentId);
  if (!doc || doc.deleted) {
    if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { status: 'cancelled' });
    return;
  }
  if (doc.status === 'ready' && payload.mode !== 'outline_only') return;
  if (doc.status === 'failed') return;

  await patchDocument(sql, doc.id, { status: 'processing' });
  if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { stage: 'S0', status: 'running' });

  let current: DocumentRecord = doc;
  try {
    // ---- S0 ----------------------------------------------------------------
    if (!(await documentHasPages(sql, doc.id))) {
      const outcome = await preflightAndExtract(stage, current, payload);
      if (outcome.status === 'failed') {
        await failDocument(stage, current, outcome.code, payload.userId, payload.aiJobId);
        return;
      }
      current = (await loadDocument(sql, doc.id)) ?? current;
      env.documents.set(doc.id, Promise.resolve(current));
    }

    // ---- S1 ----------------------------------------------------------------
    if (!(await documentHasNodes(sql, doc.id))) {
      const mergePath = (await listNodes(sql, doc.subjectId)).length > 0;
      if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { stage: mergePath ? 'S1_merge' : 'S1', status: 'running' });
      const pageCount = current.pageCount ?? (await pageCountOf(sql, doc.id));
      const pdf = await env.sources.pdf(current);
      const existing = await listNodes(sql, doc.subjectId);
      const outline = await runOutlineCalls(env, current, {
        jobId: payload.aiJobId,
        pageCount,
        cutStarts: readBookmarkStarts(pdf),
        existing,
      });
      if (outline.status === 'failed') {
        await failDocument(stage, current, outline.code, payload.userId, payload.aiJobId);
        return;
      }
      const written = await writeOutline(ctx.db, current, outline.outline, pageCount);
      if (!written.normalized.isStudyMaterial) {
        await failDocument(stage, current, 'not_study_material', payload.userId, payload.aiJobId);
        return;
      }
      ctx.log.info({ units: written.normalized.units.length, warnings: written.normalized.warnings.length }, 'outline written');
    }

    if (payload.mode === 'outline_only') {
      await patchDocument(sql, doc.id, { status: 'ready' });
      if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { stage: 'S1', status: 'succeeded' });
      return;
    }

    // ---- S2 (and onward through topic_content) -----------------------------
    const touched = (await nodeSourcesOfDocument(sql, doc.id)).filter((s) => s.kind === 'topic');
    const topicIds = [...new Set(touched.map((t) => t.nodeId))];
    if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { stage: 'S2', status: 'running', items_total: topicIds.length, items_done: 0 });
    if (topicIds.length === 0) {
      await finalizeDocument(stage, current, payload);
      return;
    }
    await ctx.enqueue(
      'ingest.topic_content',
      {
        stage: 'S2',
        subject_id: doc.subjectId,
        document_id: doc.id,
        user_id: payload.userId ?? doc.uploadedBy,
        node_ids: topicIds,
        kinds: ['concepts'],
        force: false,
        ai_job_id: payload.aiJobId,
      },
      { singletonKey: `topic-content:S2:${doc.id}` },
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await parkForBudget(stage, current, payload, err.resetsAt);
      return;
    }
    throw err;
  }
}

async function pageCountOf(sql: Sql, documentId: string): Promise<number> {
  const { rows } = await sql.query<{ n: string }>(`select count(*)::text as n from public.document_pages where document_id = $1`, [documentId]);
  return Number(rows[0]?.n ?? '0');
}

/** S0: download, preflight, text layer and spans, page rows, then the render and transcription jobs. */
async function preflightAndExtract(
  stage: Stage,
  doc: DocumentRecord,
  payload: IngestPayload,
): Promise<{ status: 'ok' } | { status: 'failed'; code: string }> {
  const { ctx, store, sql } = stage;
  let bytes: Uint8Array;
  try {
    bytes = await store.download(BUCKET.documents, doc.storagePath);
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'document download failed');
    throw err;
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { status: 'failed', code: 'too_large' };
  const pre = await preflightPdf(bytes, { maxBytes: MAX_UPLOAD_BYTES, maxPages: MAX_PAGES });
  if (!pre.ok) return { status: 'failed', code: pre.code };

  const pages = await extractPages(bytes);
  const rows: PageRecord[] = [];
  await mapLimit(pages, 8, async (page: PageExtraction) => {
    if (page.spans.length === 0) return;
    const key = keys.pageText(doc.id, page.pageNumber);
    await store.upload(BUCKET.pageText, key, new TextEncoder().encode(JSON.stringify(spansFile(page.spans))), 'application/json');
  });
  for (const page of pages) {
    rows.push({
      pageNumber: page.pageNumber,
      text: page.text,
      textSource: page.scanned ? 'none' : 'pdf_text_layer',
      charCount: page.charCount,
      hasImages: page.hasImages,
      imagePath: null,
      thumbnailPath: null,
      textItemsPath: page.spans.length > 0 ? keys.pageText(doc.id, page.pageNumber) : null,
      transcriptionConfidence: null,
    });
  }
  await upsertPages(sql, doc.id, rows);
  await patchDocument(sql, doc.id, { pageCount: pages.length, hasBookmarks: pre.hasBookmarks });

  await ctx.enqueue('ingest.render_pages', { document_id: doc.id, user_id: payload.userId, ai_job_id: payload.aiJobId }, {
    singletonKey: `render:${doc.id}`,
  });
  const scanned = pages.filter((p) => p.scanned).map((p) => p.pageNumber);
  if (scanned.length > 0) {
    await ctx.enqueue('ingest.transcribe_pages', { document_id: doc.id, pages: scanned, user_id: payload.userId, ai_job_id: payload.aiJobId }, {
      singletonKey: `transcribe:${doc.id}`,
    });
  }
  return { status: 'ok' };
}

/** ingest.render_pages: page images and thumbnails (ING-02.4). Independent of S1, so it does not block the outline. */
export async function runRenderPages(ctx: JobContext, store: ObjectStore, documentId: string): Promise<number> {
  const doc = await loadDocument(ctx.db, documentId);
  if (!doc || doc.deleted) return 0;
  const bytes = await store.download(BUCKET.documents, doc.storagePath);
  const { rows } = await ctx.db.query<{ page_number: number }>(
    `select page_number from public.document_pages where document_id = $1 and image_path is null order by page_number`,
    [documentId],
  );
  const pageNumbers = rows.map((r) => r.page_number);
  return renderPages(bytes, pageNumbers, async (rendered) => {
    const imageKey = keys.pageImage(documentId, rendered.pageNumber, rendered.image.extension);
    await store.upload(BUCKET.pageImages, imageKey, rendered.image.bytes, rendered.image.contentType);
    const thumbKey = keys.thumb(documentId, rendered.pageNumber);
    await store.upload(BUCKET.pageImages, thumbKey, rendered.thumb.bytes, 'image/jpeg');
    await setPageAssets(ctx.db, documentId, [{ pageNumber: rendered.pageNumber, imagePath: imageKey, thumbnailPath: thumbKey }]);
  });
}

// ---------------------------------------------------------------------------
// ingest.transcribe_pages (ING-02.6, T4)
// ---------------------------------------------------------------------------

export async function runTranscription(ctx: JobContext, store: ObjectStore, payload: { documentId: string; pages: number[]; userId: string | null; aiJobId: string | null }): Promise<void> {
  const stage = stageOf(ctx, store);
  const doc = await loadDocument(ctx.db, payload.documentId);
  if (!doc || doc.deleted) return;
  const wanted = payload.pages.length > 0 ? payload.pages : await scannedPages(ctx.db, doc.id);
  const runs = transcriptionRuns(wanted);
  if (runs.length === 0) return;
  const subject = await loadSubject(ctx.db, doc.subjectId);
  const language = subject?.contentLanguage ?? doc.language ?? 'pt-BR';
  const genBatchId = uuidV7();
  try {
    const items = [];
    for (const run of runs) {
      items.push(
        await transcriptionItem(stage.env, { id: doc.id, title: doc.title, storagePath: doc.storagePath }, run, {
          jobId: payload.aiJobId,
          userId: payload.userId ?? doc.uploadedBy,
          subjectId: doc.subjectId,
          ownerClassGroupId: doc.ownerClassGroupId,
          language,
          genBatchId,
        }),
      );
    }
    await submitWave(stage.env, {
      purpose: 'transcription',
      aiJobId: payload.aiJobId,
      userId: payload.userId ?? doc.uploadedBy,
      subjectId: doc.subjectId,
      documentId: doc.id,
      topicIds: [],
      items,
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const when = nextLocalMidnight(ctx.now(), await timezoneOf(ctx.db, payload.userId));
      await ctx.enqueue('ingest.transcribe_pages', { document_id: doc.id, pages: wanted, user_id: payload.userId, ai_job_id: payload.aiJobId }, {
        startAfter: when,
        singletonKey: `transcribe:${doc.id}:resume`,
      });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ingest.topic_content (S2 concepts, S4 content)
// ---------------------------------------------------------------------------

export interface TopicContentPayload {
  stage: 'S2' | 'S4';
  subjectId: string;
  documentId: string | null;
  userId: string | null;
  nodeIds: string[];
  kinds: string[];
  force: boolean;
  aiJobId: string | null;
}

export async function runTopicContent(ctx: JobContext, store: ObjectStore, payload: TopicContentPayload): Promise<void> {
  const stage = stageOf(ctx, store);
  const { sql } = stage;
  const genBatchId = uuidV7();
  try {
    if (payload.stage === 'S2') {
      await runConcepts(stage, payload, genBatchId);
      return;
    }
    await runContent(stage, payload, genBatchId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      if (payload.documentId) {
        const doc = await loadDocument(sql, payload.documentId);
        if (doc) await parkForBudget(stage, doc, { documentId: doc.id, mode: 'resume', userId: payload.userId, aiJobId: payload.aiJobId }, err.resetsAt);
      }
      return;
    }
    throw err;
  }
}

async function runConcepts(stage: Stage, payload: TopicContentPayload, genBatchId: string): Promise<void> {
  const { env, sql } = stage;
  const withConcepts = await topicsWithConcepts(sql, payload.nodeIds, payload.documentId);
  const todo: TopicBundle[] = [];
  for (const id of payload.nodeIds) {
    if (withConcepts.has(id)) continue;
    const bundle = await loadTopicBundle(sql, id);
    if (bundle) todo.push(bundle);
  }
  const docLanguage = payload.documentId ? (await loadDocument(sql, payload.documentId))?.language ?? null : null;
  if (todo.length > 0) {
    const items = [];
    for (const bundle of todo) {
      const spans = payload.documentId ? sourcesOf(bundle, payload.documentId) : bundle.sources;
      if (spans.length === 0) continue;
      const refs = await topicSliceRefs(env, spans);
      items.push(
        await topicItem(env, bundle, 'concepts', refs, {
          jobId: payload.aiJobId,
          userId: payload.userId,
          documentId: payload.documentId,
          genBatchId,
          force: false,
          language: contentLanguageOf(bundle, docLanguage),
        }),
      );
    }
    if (items.length > 0) {
      await submitWave(env, {
        purpose: 'concepts',
        aiJobId: payload.aiJobId,
        userId: payload.userId,
        subjectId: payload.subjectId,
        documentId: payload.documentId,
        topicIds: items.map((i) => i.item.topicId as string),
        items,
      });
      return;
    }
  }
  await continueAfterConcepts(stage, payload);
}

/** After S2: S3 prerequisites and S4 content run as their own jobs (both read the written concepts). */
export async function continueAfterConcepts(stage: Stage, payload: TopicContentPayload): Promise<void> {
  const { ctx } = stage;
  if (payload.documentId) {
    await ctx.enqueue('ingest.prerequisites', {
      subject_id: payload.subjectId,
      document_id: payload.documentId,
      user_id: payload.userId,
      ai_job_id: payload.aiJobId,
    }, { singletonKey: `prereq:${payload.subjectId}:${payload.documentId}` });
  }
  await ctx.enqueue('ingest.topic_content', {
    stage: 'S4',
    subject_id: payload.subjectId,
    document_id: payload.documentId,
    user_id: payload.userId,
    node_ids: payload.nodeIds,
    kinds: ['notes', 'glossary', 'cards', 'questions', 'find_error', 'problems'],
    force: false,
    ai_job_id: payload.aiJobId,
  }, { singletonKey: `topic-content:S4:${payload.documentId ?? payload.nodeIds.join(',')}` });
}

/** Kinds that already have output for a topic (idempotency; ai-pipeline §10.3). */
async function existingKinds(sql: Sql, topicId: string): Promise<Set<TopicKind>> {
  const found = new Set<TopicKind>();
  if (await tableExists(sql, 'public.notes')) {
    const { rows } = await sql.query<{ depth: string }>(
      `select depth from public.notes where node_id = $1 and status = 'ready' and deleted_at is null`,
      [topicId],
    );
    for (const r of rows) {
      if (r.depth === 'tldr') found.add('tldr');
      if (r.depth === 'study') found.add('study');
      if (r.depth === 'deep') found.add('deep');
    }
  }
  if (await tableExists(sql, 'public.glossary_terms')) {
    const { rows } = await sql.query<{ n: string }>(
      `select count(*)::text as n from public.glossary_terms
        where node_id = $1 or node_id in (select id from public.knowledge_nodes where parent_id = $1)`,
      [topicId],
    );
    if (Number(rows[0]?.n ?? '0') > 0) found.add('glossary');
  }
  const cards = await sql.query<{ n: string }>(`select count(*)::text as n from public.cards where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active'`, [topicId]);
  if (Number(cards.rows[0]?.n ?? '0') > 0) found.add('cards');
  const questions = await sql.query<{ type: string; n: string }>(
    `select type, count(*)::text as n from public.questions
      where node_id = $1 and origin = 'generated' and deleted_at is null and status = 'active' group by type`,
    [topicId],
  );
  for (const row of questions.rows) {
    if (Number(row.n) === 0) continue;
    if (row.type === 'find_error') found.add('find_error');
    else if (row.type === 'problem') found.add('problems');
    else found.add('questions');
  }
  return found;
}

async function runContent(stage: Stage, payload: TopicContentPayload, genBatchId: string): Promise<void> {
  const { env, sql } = stage;
  const kinds = expandKinds(payload.kinds).filter((k) => k !== 'concepts');
  const feedEnabled = await tableExists(sql, 'public.feed_items');
  const docLanguage = payload.documentId ? (await loadDocument(sql, payload.documentId))?.language ?? null : null;
  const items = [];
  const topicIds: string[] = [];
  for (const topicId of payload.nodeIds) {
    const bundle = await loadTopicBundle(sql, topicId);
    if (!bundle) continue;
    const present = payload.force ? new Set<TopicKind>() : await existingKinds(sql, topicId);
    // PRA-08.1: problem sets only for quantitative topics.
    const wanted = kinds.filter((k) => !present.has(k) && (k !== 'feed' || feedEnabled) && (k !== 'problems' || isQuantitativeTopic(bundle)));
    if (wanted.length === 0) continue;
    const refs = await topicSliceRefs(env, bundle.sources);
    if (refs.length === 0) continue;
    topicIds.push(topicId);
    for (const kind of wanted) {
      items.push(
        await topicItem(env, bundle, kind, refs, {
          jobId: payload.aiJobId,
          userId: payload.userId,
          documentId: payload.documentId,
          genBatchId,
          force: payload.force,
          language: contentLanguageOf(bundle, docLanguage),
        }),
      );
    }
  }
  if (items.length === 0) {
    await finishTopics(stage, payload, [], new Set(payload.nodeIds), new Set());
    return;
  }
  await setContentStatus(sql, topicIds, 'generating');
  await submitWave(env, {
    purpose: 'content',
    aiJobId: payload.aiJobId,
    userId: payload.userId,
    subjectId: payload.subjectId,
    documentId: payload.documentId,
    topicIds,
    items,
  });
}

/** Called by the batch.poll job when a content wave has been collected. */
export async function onWaveCollected(ctx: JobContext, store: ObjectStore, plan: WavePlan, summary: PollOutcomeSummary): Promise<void> {
  const stage = stageOf(ctx, store);
  if (plan.purpose === 'concepts') {
    await continueAfterConcepts(stage, {
      stage: 'S2',
      subjectId: plan.subjectId,
      documentId: plan.documentId,
      userId: plan.userId,
      nodeIds: plan.topicIds,
      kinds: ['concepts'],
      force: false,
      aiJobId: plan.aiJobId,
    });
    return;
  }
  if (plan.purpose === 'transcription') {
    ctx.log.info({ items: plan.items.length }, 'transcription wave collected');
    return;
  }
  const payload: TopicContentPayload = {
    stage: 'S4',
    subjectId: plan.subjectId,
    documentId: plan.documentId,
    userId: plan.userId,
    nodeIds: plan.topicIds,
    kinds: [],
    force: false,
    aiJobId: plan.aiJobId,
  };
  await finishTopics(stage, payload, plan.topicIds, summary.topicsOk, summary.topicsFailed, summary.budgetExceeded);
}

/** Sets content_status per topic and finalizes the document when no topic is still generating. */
async function finishTopics(
  stage: Stage,
  payload: TopicContentPayload,
  topicIds: string[],
  ok: Set<string>,
  failed: Set<string>,
  budgetExceeded = false,
): Promise<void> {
  const { sql } = stage;
  const okIds = topicIds.filter((id) => ok.has(id));
  const failIds = topicIds.filter((id) => failed.has(id) || (!ok.has(id)));
  await setContentStatus(sql, okIds, 'ready');
  await setContentStatus(sql, failIds, budgetExceeded ? 'pending' : 'failed');
  if (payload.aiJobId) {
    await applyProgress(sql, payload.aiJobId, {
      stage: 'S4',
      items_total: topicIds.length,
      items_done: okIds.length + failIds.length,
    });
  }
  if (budgetExceeded && payload.documentId) {
    const doc = await loadDocument(sql, payload.documentId);
    if (doc) await parkForBudget(stage, doc, { documentId: doc.id, mode: 'resume', userId: payload.userId, aiJobId: payload.aiJobId }, undefined);
    return;
  }
  if (!payload.documentId) return;
  const pending = await sql.query<{ n: string }>(
    `select count(*)::text as n from public.knowledge_nodes n
      where n.kind = 'topic' and n.deleted_at is null and n.content_status in ('pending','generating')
        and n.id in (select node_id from public.node_sources where document_id = $1 and deleted_at is null)`,
    [payload.documentId],
  );
  if (Number(pending.rows[0]?.n ?? '0') > 0) return;
  const doc = await loadDocument(sql, payload.documentId);
  if (!doc) return;
  await finalizeDocument(stage, doc, { documentId: doc.id, mode: 'full', userId: payload.userId, aiJobId: payload.aiJobId });
}

async function finalizeDocument(stage: Stage, doc: DocumentRecord, payload: IngestPayload): Promise<void> {
  const { sql } = stage;
  const counts = await sql.query<{ ready: string; total: string }>(
    `select count(*) filter (where content_status = 'ready')::text as ready, count(*)::text as total
       from public.knowledge_nodes n
      where n.kind = 'topic' and n.deleted_at is null
        and n.id in (select node_id from public.node_sources where document_id = $1 and deleted_at is null)`,
    [doc.id],
  );
  const ready = Number(counts.rows[0]?.ready ?? '0');
  const total = Number(counts.rows[0]?.total ?? '0');
  const allFailed = total > 0 && ready === 0;
  if (allFailed) {
    await patchDocument(sql, doc.id, { status: 'failed', errorCode: 'ai_failed' });
    if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { status: 'failed', error_code: 'ai_failed', items_total: total, items_done: total });
    await notifyDocument(stage, doc, payload.userId, 'failed', 'ai_failed');
    return;
  }
  await patchDocument(sql, doc.id, { status: 'ready' });
  if (payload.aiJobId) await applyProgress(sql, payload.aiJobId, { status: 'succeeded', stage: 'S4', items_total: total, items_done: total });
  await notifyDocument(stage, doc, payload.userId, 'ready');
}

// ---------------------------------------------------------------------------
// ingest.prerequisites (S3) and content.regenerate_topic
// ---------------------------------------------------------------------------

export async function runPrereqJob(ctx: JobContext, payload: { subjectId: string; documentId: string | null; userId: string | null; aiJobId: string | null }): Promise<void> {
  const subject = await loadSubject(ctx.db, payload.subjectId);
  if (!subject) return;
  const doc = payload.documentId ? await loadDocument(ctx.db, payload.documentId) : null;
  try {
    const result = await runPrerequisites(ctx, {
      subjectId: subject.id,
      subjectName: subject.name,
      ownerClassGroupId: subject.ownerClassGroupId,
      userId: payload.userId,
      aiJobId: payload.aiJobId,
      uploadedBy: doc?.uploadedBy ?? subject.createdBy,
      documentId: payload.documentId,
    });
    ctx.log.info({ status: result.status, written: result.written, dropped: result.dropped }, 'prerequisites stage');
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Prerequisites are optional (ING-03.5): the rest of the pipeline proceeds without them.
      ctx.log.warn('prerequisites skipped: budget exhausted');
      return;
    }
    throw err;
  }
}

export async function runRegenerate(ctx: JobContext, payload: { nodeId: string; kinds: string[]; userId: string | null }): Promise<void> {
  const node = await ctx.db.query<{ subject_id: string; origin_document_id: string | null; kind: string; parent_id: string | null }>(
    `select subject_id, origin_document_id, kind, parent_id from public.knowledge_nodes where id = $1 and deleted_at is null`,
    [payload.nodeId],
  );
  const row = node.rows[0];
  if (!row) throw new PermanentJobError('not_found', 'topic not found');
  const topicId = row.kind === 'topic' ? payload.nodeId : row.parent_id;
  if (!topicId) throw new PermanentJobError('invalid_payload', 'regeneration needs a topic');
  await ctx.enqueue('ingest.topic_content', {
    stage: 'S4',
    subject_id: row.subject_id,
    document_id: row.origin_document_id,
    user_id: payload.userId,
    node_ids: [topicId],
    kinds: payload.kinds.length > 0 ? payload.kinds : ['notes', 'glossary', 'cards', 'questions'],
    force: true,
    ai_job_id: null,
  }, { singletonKey: `regen:${topicId}:${uuidV7()}` });
}

