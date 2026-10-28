// ENEM bank import (ENM-02.8–02.9, spec 09 §8.1; api.md §7 enem.import_edition). An admin uploads the edition's
// raw files to enem/{year}/raw/ (manifest.json, the ITENS_PROVA microdata CSV, one booklet PDF per day and its
// answer key). enem.import_edition parses the microdata (positions, keys, skills, annulled flags, TRI parameters),
// locates the "QUESTÃO n" markers, crops each item and fans out enem.import_item, which transcribes, cross-checks
// the key, tags the ENEM topics and writes the commented solution. Nothing is published unless every check
// passes; the rest waits on the admin review page with its review_notes.
import { z } from 'zod';
import { toStdParams, type EnemArea, type TriParamScale } from '@studify/shared';
import { EnemItemExplanation, EnemItemTopics, EnemItemTranscription, getTask } from '@studify/prompts';
import { BudgetExceededError } from '@studify/ai';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { runPrompt } from '../lib/ai-adapter.ts';
import { JobDataError, chunk, unwrap, unwrapRows } from '../lib/db.ts';
import { extractPages } from '../ingest/pdf-text.ts';
import { pageSliceBase64, renderCrops } from '../enem/crops.ts';
import {
  cropRegions,
  editionScale,
  findQuestionMarkers,
  groupItems,
  itemForMarker,
  parseAnswerKey,
  parseItensProva,
  positionInArea,
  type ImportManifest,
  type ItemGroup,
} from '../enem/import-parse.ts';

const BUCKET = 'enem';
const AREA_NAME: Record<EnemArea, string> = { LC: 'Linguagens', CH: 'Ciências Humanas', CN: 'Ciências da Natureza', MT: 'Matemática' };
const AREA_DAY: Record<EnemArea, 1 | 2> = { LC: 1, CH: 1, CN: 2, MT: 2 };

const ManifestSchema = z.object({
  application: z.enum(['regular', 'ppl', 'other']).optional(),
  microdata: z.string().min(1),
  days: z.array(
    z.object({
      day: z.union([z.literal(1), z.literal(2)]),
      booklet: z.string().min(1),
      co_prova: z.record(z.string(), z.string()),
      answer_key: z.string().optional(),
      color: z.string().optional(),
    }),
  ),
});

async function download(ctx: JobContext, path: string): Promise<Uint8Array> {
  const res = await ctx.supabase.storage.from(BUCKET).download(path);
  if (res.error || !res.data) throw new JobDataError(`enem storage: ${path} not found (${res.error?.message ?? 'empty'})`, 'missing_input');
  return new Uint8Array(await res.data.arrayBuffer());
}

/** Text of an uploaded file: .pdf through its text layer, anything else as UTF-8 (Latin-1 when not valid UTF-8). */
async function fileText(ctx: JobContext, path: string): Promise<string> {
  const bytes = await download(ctx, path);
  if (path.toLowerCase().endsWith('.pdf')) return (await extractPages(bytes)).map((p) => p.text).join('\n');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** The system subject of an area's bank (owned by the importing admin) and its root node. */
export async function ensureBankSubject(ctx: JobContext, area: EnemArea, adminId: string): Promise<{ subjectId: string; nodeId: string }> {
  let subject = unwrap(await ctx.supabase.from('subjects').select('id').eq('system_kind', 'enem_bank').eq('enem_area', area).is('deleted_at', null).maybeSingle(), 'subjects') as { id: string } | null;
  if (!subject) {
    const id = crypto.randomUUID();
    unwrap(
      await ctx.supabase.from('subjects').insert({ id, owner_profile_id: adminId, created_by: adminId, name: `ENEM — ${AREA_NAME[area]}`, color: '#2f5aa8', icon: 'school', enem_area: area, system_kind: 'enem_bank', content_language: 'pt-BR' }),
      'subjects',
    );
    subject = { id };
  }
  let node = unwrap(await ctx.supabase.from('knowledge_nodes').select('id').eq('subject_id', subject.id).eq('kind', 'unit').is('deleted_at', null).limit(1).maybeSingle(), 'knowledge_nodes') as { id: string } | null;
  if (!node) {
    const id = crypto.randomUUID();
    unwrap(await ctx.supabase.from('knowledge_nodes').insert({ id, subject_id: subject.id, parent_id: null, kind: 'unit', title: `Banco ENEM — ${AREA_NAME[area]}`, content_status: 'skipped_excluded' }), 'knowledge_nodes');
    node = { id };
  }
  return { subjectId: subject.id, nodeId: node.id };
}

const ImportPayload = z.object({
  year: z.number().int().min(2009).max(2100),
  application: z.enum(['regular', 'ppl', 'other']).default('regular'),
  ai_job_id: z.uuid().nullable().optional(),
  requested_by: z.uuid(),
});

export interface ImportOutcome {
  items: number;
  cropped: number;
  queued: number;
  needsReview: number;
}

export async function handleImportEdition(ctx: JobContext, data: Record<string, unknown>): Promise<ImportOutcome> {
  const payload = parsePayload(ImportPayload, data, 'enem.import_edition');
  const base = `${payload.year}/raw`;
  const manifest = ManifestSchema.parse(JSON.parse(await fileText(ctx, `${base}/manifest.json`))) as ImportManifest;
  const application = manifest.application ?? payload.application;
  await ctx.progress({ stage: 'microdata', progress: 0.05 });
  const groups = groupItems(parseItensProva(await fileText(ctx, `${base}/${manifest.microdata}`)));
  if (groups.length === 0) throw new JobDataError('enem.import_edition: no items in the microdata', 'invalid_input');
  const scale: TriParamScale = editionScale(groups);

  // Edition row (dates stay provisional until an admin verifies the edital).
  const edition = unwrap(await ctx.supabase.from('enem_editions').select('year').eq('year', payload.year).maybeSingle(), 'enem_editions');
  if (!edition) unwrap(await ctx.supabase.from('enem_editions').insert({ year: payload.year, dates_status: 'provisional' }), 'enem_editions');

  // Questions + enem_items + params, one per CO_ITEM. Re-imports keep the ids and the review state.
  const existing = unwrapRows<{ id: string; question_id: string; co_item: string; review_status: string }>(
    await ctx.supabase.from('enem_items').select('id,question_id,co_item,review_status').eq('edition_year', payload.year).eq('application', application),
    'enem_items',
  );
  const byCoItem = new Map(existing.map((e) => [e.co_item, e] as const));
  const subjects = new Map<EnemArea, { subjectId: string; nodeId: string }>();
  const itemIdOf = new Map<string, string>();
  for (const g of groups) {
    if (!subjects.has(g.area)) subjects.set(g.area, await ensureBankSubject(ctx, g.area, payload.requested_by));
    const bank = subjects.get(g.area)!;
    const found = byCoItem.get(g.coItem);
    const itemId = found?.id ?? crypto.randomUUID();
    const questionId = found?.question_id ?? crypto.randomUUID();
    itemIdOf.set(g.coItem, itemId);
    if (!found) {
      unwrap(
        await ctx.supabase.from('questions').insert({
          id: questionId,
          subject_id: bank.subjectId,
          node_id: bank.nodeId,
          type: 'mcq_single',
          stem: `ENEM ${payload.year} — questão ${g.positions[0]?.position ?? ''}`,
          payload: { options: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, text: id, rationale: '—' })), correct: g.key ?? 'A' },
          origin: 'enem_official',
          answer_key_source: 'official',
          enem_skill_code: g.skill,
          position: positionInArea(g.positions[0]?.position ?? 1),
          status: 'active',
          review_status: 'pending',
        }),
        'questions',
      );
    }
    const row = {
      id: itemId,
      question_id: questionId,
      edition_year: payload.year,
      application,
      day: AREA_DAY[g.area],
      area: g.area,
      co_item: g.coItem,
      positions: g.positions,
      answer_key: g.key,
      skill_code: g.skill,
      language: g.language,
      annulled: g.annulled,
      annul_reason: g.annulReason,
    };
    unwrap(await ctx.supabase.from('enem_items').upsert(row, { onConflict: 'edition_year,application,co_item' }), 'enem_items');
    if (g.params) {
      unwrap(
        await ctx.supabase.from('enem_item_params').upsert({ enem_item_id: itemId, a: g.params.a, b: g.params.b, c: g.params.c, scale, source: `microdata_${payload.year}`, logistic_d: 1 }, { onConflict: 'enem_item_id' }),
        'enem_item_params',
      );
    }
  }

  // Booklets: markers → crops → storage; keys cross-checked; one enem.import_item per cropped item.
  let cropped = 0;
  let queued = 0;
  const matched = new Set<string>();
  for (const [i, day] of manifest.days.entries()) {
    await ctx.progress({ stage: `booklet_${day.day}`, progress: 0.2 + 0.3 * (i / manifest.days.length) });
    const bookletPath = `${base}/${day.booklet}`;
    const pdf = await download(ctx, bookletPath);
    const pages = await extractPages(pdf);
    const markers = findQuestionMarkers(pages.map((p) => ({ pageNumber: p.pageNumber, spans: p.spans })));
    const regions = cropRegions(markers, pages.length);
    const keys = day.answer_key ? parseAnswerKey(await fileText(ctx, `${base}/${day.answer_key}`)) : null;
    for (const marker of markers) {
      const group = itemForMarker(groups, day.co_prova as Partial<Record<EnemArea, string>>, marker);
      if (!group || matched.has(group.coItem)) continue;
      matched.add(group.coItem);
      const itemId = itemIdOf.get(group.coItem)!;
      const images = await renderCrops(pdf, regions.get(marker) ?? []);
      const paths: string[] = [];
      for (const [n, img] of images.entries()) {
        const path = `${payload.year}/${group.coItem}/${n + 1}.${img.extension}`;
        const up = await ctx.supabase.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: true });
        if (up.error) throw new JobDataError(`enem crop upload failed: ${up.error.message}`, 'storage');
        paths.push(path);
      }
      cropped++;
      const notes: string[] = [];
      const printed = keys?.get(marker.position);
      if (!keys) notes.push('answer_key_missing');
      else if (group.annulled) {
        // Annulled items keep no key; the banner explains (ENM-02.6).
      } else if (printed === undefined) notes.push('answer_key_position_missing');
      else if (printed !== group.key) notes.push(`answer_key_mismatch:${printed ?? 'null'}≠${group.key ?? 'null'}`);
      unwrap(await ctx.supabase.from('enem_items').update({ crop_paths: paths, review_notes: notes }).eq('id', itemId), 'enem_items');
      await ctx.enqueue(
        'enem.import_item',
        { enem_item_id: itemId, booklet_path: bookletPath, page: marker.page, ai_job_id: payload.ai_job_id ?? null },
        { singletonKey: `enem.import_item:${itemId}` },
      );
      queued++;
    }
  }
  // Items no booklet marker matched: stay under review with the reason.
  const unmatched = groups.filter((g) => !matched.has(g.coItem)).map((g) => itemIdOf.get(g.coItem)!);
  for (const part of chunk(unmatched, 150)) unwrap(await ctx.supabase.from('enem_items').update({ review_notes: ['crop_not_found'], review_status: 'needs_review' }).in('id', part), 'enem_items');
  await ctx.progress({ stage: 'items', progress: 0.5, items_total: queued, items_done: 0 });
  return { items: groups.length, cropped, queued, needsReview: unmatched.length };
}

const ItemPayload = z.object({ enem_item_id: z.uuid(), booklet_path: z.string().min(1), page: z.number().int().min(1), ai_job_id: z.uuid().nullable().optional() });

interface ItemRow {
  id: string;
  question_id: string;
  edition_year: number;
  day: 1 | 2;
  area: EnemArea;
  positions: ItemGroup['positions'];
  answer_key: 'A' | 'B' | 'C' | 'D' | 'E' | null;
  skill_code: string | null;
  annulled: boolean;
  crop_paths: string[];
  review_notes: string[];
}

/** The booklet of the last item stays in memory: consecutive items of one import read the same file. */
let bookletCache: { path: string; bytes: Uint8Array } | null = null;

export async function handleImportItem(ctx: JobContext, data: Record<string, unknown>): Promise<{ status: 'published' | 'needs_review' | 'skipped'; notes: string[] }> {
  const payload = parsePayload(ItemPayload, data, 'enem.import_item');
  const item = unwrap(
    await ctx.supabase.from('enem_items').select('id,question_id,edition_year,day,area,positions,answer_key,skill_code,annulled,crop_paths,review_notes').eq('id', payload.enem_item_id).maybeSingle(),
    'enem_items',
  ) as ItemRow | null;
  if (!item) return { status: 'skipped', notes: [] };
  const notes = [...item.review_notes];
  const scope = { userId: null, jobId: payload.ai_job_id ?? null, feature: 'ENM-02' };
  const ref = { edition: item.edition_year, day: item.day, area: item.area, position: item.positions[0]?.position ?? 1 };

  if (!bookletCache || bookletCache.path !== payload.booklet_path) bookletCache = { path: payload.booklet_path, bytes: await download(ctx, payload.booklet_path) };
  const usableCrops: Array<{ data: string; mediaType: 'image/jpeg' | 'image/webp' }> = [];
  for (const path of item.crop_paths) {
    const bytes = await download(ctx, path);
    usableCrops.push({ data: Buffer.from(bytes).toString('base64'), mediaType: path.endsWith('.jpg') ? 'image/jpeg' : 'image/webp' });
  }
  const page = { documentId: `enem-${item.edition_year}-day${item.day}`, title: `ENEM ${item.edition_year} — ${item.day}º dia`, pages: [payload.page], source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: await pageSliceBase64(bookletCache.bytes, payload.page) } };

  try {
    // 1. Transcription (statement, alternatives, alt text).
    const tr = await runPrompt(ctx.ai, { task: getTask('enem.bank.transcribe'), schema: EnemItemTranscription as unknown as z.ZodType<z.infer<typeof EnemItemTranscription>>, input: { ...ref, crops: usableCrops, page }, scope });
    if (tr.result.status !== 'ok') {
      notes.push(`transcription_${tr.result.status}`);
      unwrap(await ctx.supabase.from('enem_items').update({ review_status: 'needs_review', review_notes: notes }).eq('id', item.id), 'enem_items');
      return { status: 'needs_review', notes };
    }
    const t = tr.result.data as z.infer<typeof EnemItemTranscription>;
    if (t.unreadable) notes.push('unreadable');
    const transcriptionMd = `${t.statement_md}\n\n${t.alternatives.map((a) => `${a.label}) ${a.text_md}`).join('\n')}`;

    // 2. ENEM topics (when the curated taxonomy exists for the area).
    const topics = unwrapRows<{ id: string; subject: string; title: string }>(await ctx.supabase.from('enem_topics').select('id,subject,title').eq('area', item.area).order('position'), 'enem_topics');
    let topicIds: string[] = [];
    let subjectName = t.subject_guess;
    if (topics.length > 0) {
      const tagged = await runPrompt(ctx.ai, {
        task: getTask('enem.bank.tagTopics'),
        schema: EnemItemTopics as unknown as z.ZodType<z.infer<typeof EnemItemTopics>>,
        input: { area: item.area, transcriptionMd, skillCode: item.skill_code, topics: topics.map((x, i) => ({ key: `T${i + 1}`, path: `${item.area} › ${x.subject} › ${x.title}` })) },
        scope,
      });
      if (tagged.result.status === 'ok') {
        const d = tagged.result.data as z.infer<typeof EnemItemTopics>;
        const byKey = new Map<string, string>(topics.map((x, i) => [`T${i + 1}`, x.id]));
        topicIds = d.enem_topic_keys.map((k) => byKey.get(k.key)).filter((v): v is string => !!v);
        subjectName = d.subject;
      }
    }

    // 3. Commented solution: must reach the official key, which the prompt receives; one paid call, else flagged
    // for review (ENM-02.5).
    let explanation: z.infer<typeof EnemItemExplanation> | null = null;
    let explanationStatus: 'ok' | 'flagged' | 'pending' = 'pending';
    if (!item.annulled && item.answer_key) {
      const ex = await runPrompt(ctx.ai, {
        task: getTask('enem.bank.explain'),
        schema: EnemItemExplanation as unknown as z.ZodType<z.infer<typeof EnemItemExplanation>>,
        input: { ...ref, crops: usableCrops, transcriptionMd, officialKey: item.answer_key, skill: item.skill_code ? { code: item.skill_code, competency: 0, description: null } : null },
        scope,
      });
      if (ex.result.status === 'ok' && (ex.result.data as z.infer<typeof EnemItemExplanation>).chosen_answer === item.answer_key) explanation = ex.result.data as z.infer<typeof EnemItemExplanation>;
      explanationStatus = explanation ? 'ok' : 'flagged';
      if (!explanation) notes.push('explanation_off_key');
    } else if (!item.annulled) {
      notes.push('answer_key_missing');
    }

    // 4. Question row and item: published only when nothing is pending.
    const why = new Map((explanation?.distractors ?? []).map((d) => [d.label, d.why_wrong] as const));
    const payloadOut = {
      options: t.alternatives.map((a) => ({ id: a.label, text: a.text_md, rationale: a.label === item.answer_key ? (explanation?.skill_explanation ?? 'Gabarito oficial.') : (why.get(a.label) ?? '—') })),
      correct: item.answer_key ?? 'A',
    };
    unwrap(
      await ctx.supabase
        .from('questions')
        .update({ stem: t.statement_md, payload: payloadOut, explanation: explanation?.solution_md ?? null, has_math: /\$/.test(transcriptionMd), format_features: t.has_figure ? ['figure'] : [] })
        .eq('id', item.question_id),
      'questions',
    );
    const publish = notes.length === 0;
    unwrap(
      await ctx.supabase
        .from('enem_items')
        .update({ transcription_md: transcriptionMd, alt_text: t.alt_text, subject: subjectName, enem_topic_ids: topicIds, explanation_status: item.annulled ? 'ok' : explanationStatus, review_status: publish ? 'ok' : 'needs_review', review_notes: notes })
        .eq('id', item.id),
      'enem_items',
    );
    if (publish) await ctx.enqueue('enem.topic_stats', {}, { singletonKey: `enem.topic_stats:${ctx.now().toISOString().slice(0, 13)}` });
    return { status: publish ? 'published' : 'needs_review', notes };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      unwrap(await ctx.supabase.from('enem_items').update({ review_status: 'needs_review', review_notes: [...notes, 'budget_exceeded'] }).eq('id', item.id), 'enem_items');
      return { status: 'needs_review', notes: [...notes, 'budget_exceeded'] };
    }
    throw err;
  }
}

/** Standardized b of an item, for checks and tests. */
export function stdB(params: { a: number; b: number; c: number; scale: TriParamScale }): number {
  return toStdParams(params).b;
}

export const jobs: JobDefinition<any>[] = [
  { name: 'enem.import_edition', retryLimit: 1, expireInSeconds: 3600, handler: async (ctx, data) => void (await handleImportEdition(ctx, data)) },
  { name: 'enem.import_item', retryLimit: 2, expireInSeconds: 900, concurrency: 4, handler: async (ctx, data) => void (await handleImportItem(ctx, data)) },
];
