// Câmera Mágica helpers (spec 11): the caller's capture, its photos as image blocks, the student's readable
// subjects, the course match of Step B (§8.5: full-text search → topics via node_sources → accept rule, with a
// tie-break call when two topics are close) and the matched pages for Step C. Every read is scoped to the caller.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTask, type CaptureImage, type PdfSlice } from '@studify/prompts';
import { ApiFailure, decideTopicMatch, type TopicMatchScore } from '@studify/shared';
import { canReadSubject, type SubjectRow } from '../shared/access.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { ftsPages, searchTerms } from '../shared/retrieval.ts';
import { prepareSlices, toBase64, toPdfSlice } from '../shared/slices.ts';
import { downloadBytes } from '../shared/storage.ts';
import type { ObjectStorage } from '@studify/storage';

export interface CaptureRow {
  id: string;
  user_id: string;
  intent: 'explain' | 'solve' | 'add_to_subject' | 'grade_answer' | 'grade_essay';
  subject_id: string | null;
  node_id: string | null;
  image_paths: string[];
  quality_flags: Record<string, unknown>;
  faces_blurred: boolean;
  content_type: string | null;
  language: string | null;
  transcription: string | null;
  confirmed_text: string | null;
  edited_ratio: number | null;
  detected_questions: Array<{ index: number; label: string; preview: string; text_md: string; complete: boolean; has_figure: boolean }> | null;
  match: { subject_id: string; node_ids: string[]; confidence: number; label: string } | null;
  result: Record<string, unknown> | null;
  solver: Record<string, unknown> | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  saved: boolean;
  document_id: string | null;
  question_id: string | null;
  essay_id: string | null;
  tutor_thread_id: string | null;
  deleted_at: string | null;
}

/** The caller's capture; someone else's or a deleted one is not found (api §2.2). */
export async function loadOwnCapture(db: SupabaseClient, userId: string, captureId: string): Promise<CaptureRow> {
  const { data, error } = await db.from('camera_captures').select('*').eq('id', captureId).maybeSingle();
  if (error) throw error;
  const row = data as CaptureRow | null;
  if (!row || row.user_id !== userId || row.deleted_at) throw new ApiFailure('not_found');
  return row;
}

function mediaTypeOf(path: string): CaptureImage['mediaType'] {
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
}

/** The capture's photos (already resized, EXIF-free and face-blurred on device, CAM-00.6), as image blocks. */
export async function captureImages(storage: ObjectStorage, paths: readonly string[], max: number): Promise<CaptureImage[]> {
  const out: CaptureImage[] = [];
  for (const path of paths.slice(0, max)) {
    out.push({ data: toBase64(await downloadBytes(storage, path)), mediaType: mediaTypeOf(path) });
  }
  if (out.length === 0) throw new ApiFailure('photo_unreadable');
  return out;
}

/** Removes the capture's photos from Storage (not study content, refusal, retention; spec 11 §8.4). */
export async function deleteCapturePhotos(storage: ObjectStorage, paths: readonly string[]): Promise<void> {
  const objects = paths.filter((p) => p.startsWith('photos/')).map((p) => p.slice('photos/'.length));
  if (objects.length === 0) return;
  await storage.remove('photos', objects);
}

const SUBJECT_COLUMNS = 'id, owner_profile_id, owner_class_group_id, created_by, content_language, is_language_subject, enem_area, name';

/** Personal subjects and subjects of the caller's active Turmas (the camera's subject list). */
export async function readableSubjects(db: SupabaseClient, userId: string): Promise<SubjectRow[]> {
  const personal = await db.from('subjects').select(SUBJECT_COLUMNS).eq('owner_profile_id', userId).is('deleted_at', null);
  if (personal.error) throw personal.error;
  const memberships = await db.from('class_group_members').select('class_group_id').eq('user_id', userId).eq('status', 'active');
  if (memberships.error) throw memberships.error;
  const groups = (memberships.data as Array<{ class_group_id: string }>).map((m) => m.class_group_id);
  let shared: SubjectRow[] = [];
  if (groups.length > 0) {
    const res = await db.from('subjects').select(SUBJECT_COLUMNS).in('owner_class_group_id', groups).is('deleted_at', null);
    if (res.error) throw res.error;
    shared = res.data as SubjectRow[];
  }
  return [...(personal.data as SubjectRow[]), ...shared];
}

/** "Biologia › Genética › 1ª Lei de Mendel" (CAM-02.3). */
export async function nodeLabel(db: SupabaseClient, subjectName: string, nodeId: string): Promise<string> {
  const titles: string[] = [];
  let current: string | null = nodeId;
  for (let depth = 0; current && depth < 4; depth++) {
    const res: { data: { title: string; parent_id: string | null } | null; error: unknown } = await db
      .from('knowledge_nodes')
      .select('id, title, parent_id')
      .eq('id', current)
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) break;
    titles.unshift(res.data.title);
    current = res.data.parent_id ?? null;
  }
  return [subjectName, ...titles].join(' › ');
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface CaptureMatch {
  subject: SubjectRow;
  nodeId: string;
  confidence: number;
  label: string;
}

/**
 * Spec 11 §8.5 Step B. Query = key concepts + the first 300 characters; FTS over the pages of the candidate
 * subjects (only the guessed one when its confidence ≥ 0.6); each page scores the share of query terms it
 * contains; a topic scores the sum of its pages, normalized over all topics. Close calls go to the tie-break
 * task (camera.matchTiebreak). Null: not in the student's material (CAM-01.3).
 */
export async function matchCapture(
  deps: Deps,
  userId: string,
  args: { keyConcepts: readonly string[]; transcription: string; subjects: readonly SubjectRow[]; guess: SubjectRow | null; guessConfidence: number },
): Promise<CaptureMatch | null> {
  const { db } = deps;
  const subjects = args.guess && args.guessConfidence >= 0.6 ? [args.guess] : [...args.subjects];
  if (subjects.length === 0) return null;
  const docsRes = await db.from('documents').select('id, subject_id').in('subject_id', subjects.map((s) => s.id)).is('deleted_at', null);
  if (docsRes.error) throw docsRes.error;
  const docs = docsRes.data as Array<{ id: string; subject_id: string }>;
  if (docs.length === 0) return null;
  const query = searchTerms(`${args.keyConcepts.join(' ')} ${args.transcription.slice(0, 300)}`);
  const terms = query.split(' ').filter(Boolean);
  if (terms.length === 0) return null;
  const hits = await ftsPages(db, docs.map((d) => d.id), terms.join(' or '), 60);
  if (hits.length === 0) return null;

  const pageScore = new Map<string, number>();
  for (const hit of hits) {
    const text = normalize(hit.text ?? '');
    const present = terms.filter((t) => text.includes(t)).length;
    pageScore.set(`${hit.document_id}|${hit.page_number}`, present / terms.length);
  }
  const hitDocs = [...new Set(hits.map((h) => h.document_id))];
  const sources = await db.from('node_sources').select('node_id, document_id, page_start, page_end').in('document_id', hitDocs).is('deleted_at', null);
  if (sources.error) throw sources.error;
  const rawScores = new Map<string, number>();
  for (const s of sources.data as Array<{ node_id: string; document_id: string; page_start: number; page_end: number }>) {
    let sum = 0;
    for (let p = s.page_start; p <= s.page_end; p++) sum += pageScore.get(`${s.document_id}|${p}`) ?? 0;
    if (sum > 0) rawScores.set(s.node_id, (rawScores.get(s.node_id) ?? 0) + sum);
  }
  if (rawScores.size === 0) return null;
  const nodes = await db.from('knowledge_nodes').select('id, subject_id, kind, title, summary, deleted_at').in('id', [...rawScores.keys()]);
  if (nodes.error) throw nodes.error;
  const topics = (nodes.data as Array<{ id: string; subject_id: string; kind: string; title: string; summary: string | null; deleted_at: string | null }>).filter(
    (n) => n.kind === 'topic' && !n.deleted_at,
  );
  const total = topics.reduce((sum, t) => sum + (rawScores.get(t.id) ?? 0), 0);
  if (total <= 0) return null;
  const scores: TopicMatchScore[] = topics.map((t) => ({ node_id: t.id, score: (rawScores.get(t.id) ?? 0) / total }));
  const decision = decideTopicMatch(scores);

  let nodeId: string | null = null;
  let confidence = 0;
  if (decision.kind === 'matched') {
    nodeId = decision.node_id;
    confidence = decision.confidence;
  } else if (decision.kind === 'ambiguous') {
    const candidates = topics.filter((t) => decision.candidates.includes(t.id));
    const keyed = candidates.map((t, i) => ({ key: `t${i + 1}`, title: t.title, summary: t.summary ?? '' }));
    const subject = subjects.find((s) => s.id === candidates[0]?.subject_id) ?? null;
    const built = getTask('camera.matchTiebreak').build({ transcription: args.transcription, keyConcepts: args.keyConcepts, candidates: keyed });
    const result = await callTask(claudeDepsFor(deps), { built, taskId: 'camera.matchTiebreak', ctx: budgetCtxFor(subject, userId, 'CAM-01', 'user') });
    const picked = (unwrapResult(result) as { node_keys: string[] }).node_keys[0];
    const index = picked ? keyed.findIndex((k) => k.key === picked) : -1;
    if (index >= 0) {
      nodeId = candidates[index]!.id;
      confidence = scores.find((s) => s.node_id === nodeId)?.score ?? 0.35;
    }
  }
  if (!nodeId) return null;
  const topic = topics.find((t) => t.id === nodeId)!;
  const subject = subjects.find((s) => s.id === topic.subject_id);
  if (!subject || !(await canReadSubject(db, userId, subject))) return null;
  return { subject, nodeId, confidence, label: await nodeLabel(db, subject.name, nodeId) };
}

/** Spec 11 §8.5 step 5: up to `maxPages` pages of the matched topic's sources, as PDF slices. */
export async function matchedSlices(deps: Deps, nodeId: string | null, maxPages = 6): Promise<PdfSlice[]> {
  if (!nodeId) return [];
  const { db } = deps;
  const sources = await db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', nodeId).is('deleted_at', null);
  if (sources.error) throw sources.error;
  const byDoc = new Map<string, number[]>();
  let budget = maxPages;
  for (const s of sources.data as Array<{ document_id: string; page_start: number; page_end: number }>) {
    const list = byDoc.get(s.document_id) ?? [];
    for (let p = s.page_start; p <= s.page_end && budget > 0; p++) {
      if (!list.includes(p)) {
        list.push(p);
        budget--;
      }
    }
    byDoc.set(s.document_id, list);
  }
  const out: PdfSlice[] = [];
  for (const [documentId, pages] of byDoc) {
    if (pages.length === 0) continue;
    const doc = await db.from('documents').select('title, storage_path, deleted_at').eq('id', documentId).maybeSingle();
    if (doc.error) throw doc.error;
    if (!doc.data || doc.data.deleted_at) continue;
    const prepared = await prepareSlices(deps, {
      documentId,
      title: doc.data.title as string,
      storagePath: doc.data.storage_path as string,
      pages,
      purpose: 'tutor',
      newId: deps.newId,
    });
    out.push(...prepared.map(toPdfSlice));
  }
  return out;
}
