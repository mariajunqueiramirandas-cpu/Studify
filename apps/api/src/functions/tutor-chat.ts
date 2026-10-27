// tutor-chat (TUT-01…06). One turn of the tutor, streamed (SSE, api §4.4):
//  budget gate (user, class B) → retrieval (FTS / knowledge map, original pages) → Claude with the thread's
//  replayed history → stream (delta, citation, status, tool, done) → store both messages with raw_content.
// Limits: 60 student messages per local day (402 budget_exhausted), 120 context pages and 200 messages per
// thread (400 with a PT-BR message). A refusal stores nothing, so the student can ask again.
// Capture threads (CAM-01.4) keep the photo's transcription and matched topic in context; voice turns
// (TUT-06.4) append the "modo voz" system message, and Me testa is not offered by voice (TUT-06.5).
import {
  ApiFailure,
  DEFAULT_TIME_ZONE,
  TutorChatReqSchema,
  wallClockOf,
  type TutorChatReq,
} from '@studify/shared';
import { getTask, documentBlocks, text as textBlock, type BuiltPrompt, type PdfSlice } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { canReadSubject, loadSubject, requireNode, requireSubject, type SubjectRow } from '../shared/access.ts';
import { citationsForStorage, openStream, toTaskCall } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { pumpStream, stopReasonOf } from '../shared/stream.ts';
import { searchTerms, ftsPages, selectNewPages, prepareTurnSlices, slicesFromStored, TUTOR_CONTEXT_PAGES_CAP, TUTOR_MESSAGES_PER_DAY, TUTOR_THREAD_MESSAGE_CAP, type StoredSlice } from '../shared/retrieval.ts';
import type { DocumentSlice } from '@studify/ai';
import type { SupabaseClient } from '@supabase/supabase-js';

const DISTRESS_MARKER = '[[APOIO]]';
type Req = TutorChatReq;

interface ThreadRow {
  id: string;
  user_id: string;
  scope_type: 'subject' | 'goal' | 'topic' | 'passage' | 'capture';
  subject_id: string | null;
  goal_id: string | null;
  node_id: string | null;
  mode: 'answer' | 'socratic' | 'quiz';
  context_pages: Array<{ document_id: string; page: number }>;
  title: string | null;
  passage: { text: string } | null;
  capture_id: string | null;
}

/** Start of the student's local day, as an ISO instant (budget and message limits reset at local midnight). */
export function startOfLocalDay(now: Date, timeZone: string): string {
  const w = wallClockOf(now, timeZone);
  const elapsedMs = ((w.hour * 60 + w.minute) * 60 + w.second) * 1000;
  return new Date(now.getTime() - elapsedMs).toISOString();
}

async function createThread(db: SupabaseClient, newId: () => string, userId: string, req: Req): Promise<ThreadRow> {
  const scope = req.scope;
  if (!scope) throw new ApiFailure('invalid_request');
  let subjectId: string | null = null;
  let goalId: string | null = null;
  let nodeId: string | null = null;
  let passage: { text: string } | null = null;
  let captureId: string | null = null;
  if (scope.type === 'subject') {
    if (!scope.subject_id) throw new ApiFailure('invalid_request');
    subjectId = (await requireSubject(db, userId, scope.subject_id, 'read')).id;
  } else if (scope.type === 'goal') {
    if (!scope.goal_id) throw new ApiFailure('invalid_request');
    const goal = await db.from('goals').select('id, user_id').eq('id', scope.goal_id).is('deleted_at', null).maybeSingle();
    if (goal.error) throw goal.error;
    if (!goal.data || goal.data.user_id !== userId) throw new ApiFailure('not_found');
    goalId = scope.goal_id;
  } else if (scope.type === 'topic') {
    if (!scope.node_id) throw new ApiFailure('invalid_request');
    const { subject } = await requireNode(db, userId, scope.node_id);
    subjectId = subject.id;
    nodeId = scope.node_id;
  } else if (scope.type === 'passage') {
    if (!scope.passage) throw new ApiFailure('invalid_request');
    if (scope.passage.document_id) {
      const doc = await db.from('documents').select('subject_id').eq('id', scope.passage.document_id).is('deleted_at', null).maybeSingle();
      if (doc.error) throw doc.error;
      if (!doc.data) throw new ApiFailure('not_found');
      subjectId = (await requireSubject(db, userId, doc.data.subject_id as string, 'read')).id;
    }
    passage = { text: scope.passage.text };
  } else {
    // CAM-01.4: follow-ups of a Câmera Mágica capture keep its subject and matched topic.
    if (!scope.capture_id) throw new ApiFailure('invalid_request');
    const capture = await db.from('camera_captures').select('id, user_id, subject_id, node_id, transcription, deleted_at').eq('id', scope.capture_id).maybeSingle();
    if (capture.error) throw capture.error;
    if (!capture.data || capture.data.user_id !== userId || capture.data.deleted_at) throw new ApiFailure('not_found');
    captureId = capture.data.id as string;
    if (capture.data.subject_id) subjectId = (await requireSubject(db, userId, capture.data.subject_id as string, 'read')).id;
    nodeId = (capture.data.node_id as string | null) ?? null;
  }
  const id = newId();
  const created = await db.from('tutor_threads').insert({
    id,
    user_id: userId,
    scope_type: scope.type,
    subject_id: subjectId,
    goal_id: goalId,
    node_id: nodeId,
    passage: scope.passage ?? null,
    capture_id: captureId,
    mode: req.mode,
    title: req.message.slice(0, 60),
    context_pages: [],
    state: {},
  });
  if (created.error) throw created.error;
  if (captureId) {
    const linked = await db.from('camera_captures').update({ tutor_thread_id: id }).eq('id', captureId);
    if (linked.error) throw linked.error;
  }
  return { id, user_id: userId, scope_type: scope.type, subject_id: subjectId, goal_id: goalId, node_id: nodeId, mode: req.mode, context_pages: [], title: req.message.slice(0, 60), passage, capture_id: captureId };
}

async function loadThread(db: SupabaseClient, userId: string, threadId: string): Promise<ThreadRow> {
  const { data, error } = await db
    .from('tutor_threads')
    .select('id, user_id, scope_type, subject_id, goal_id, node_id, mode, context_pages, title, passage, capture_id, archived_at')
    .eq('id', threadId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.user_id !== userId || data.archived_at) throw new ApiFailure('not_found');
  return data as unknown as ThreadRow;
}

/** The student's documents in the thread's subjects (the retrieval set). Access is checked by the caller. */
async function documentsFor(db: SupabaseClient, subjectIds: string[]) {
  if (subjectIds.length === 0) return new Map<string, { title: string; storagePath: string; subjectId: string }>();
  const { data, error } = await db.from('documents').select('id, title, storage_path, subject_id').in('subject_id', subjectIds).is('deleted_at', null);
  if (error) throw error;
  return new Map(
    (data as Array<{ id: string; title: string; storage_path: string; subject_id: string }>).map((d) => [
      d.id,
      { title: d.title, storagePath: d.storage_path, subjectId: d.subject_id },
    ]),
  );
}

export const handler = defineFunction<Req>({
  name: 'tutor-chat',
  mutating: true,
  aiCall: true,
  input: TutorChatReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    if (input.voice && input.mode === 'quiz') {
      throw new ApiFailure('invalid_request', { message: 'O modo Me testa não funciona por voz. Use Responder ou Socrático.' });
    }

    const thread = input.thread_id ? await loadThread(db, userId, input.thread_id) : await createThread(db, deps.newId, userId, input);
    const subject: SubjectRow | null = thread.subject_id
      ? await requireSubject(db, userId, thread.subject_id, 'read')
      : null;

    // Limits (api §4.4, security §7): daily student messages, thread length.
    const dayStart = startOfLocalDay(ctx.now, DEFAULT_TIME_ZONE);
    const todays = await db.from('tutor_messages').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('role', 'user').gte('created_at', dayStart);
    if (todays.error) throw todays.error;
    if ((todays.count ?? 0) >= TUTOR_MESSAGES_PER_DAY) {
      throw new ApiFailure('budget_exhausted', { message: 'Você já fez as perguntas de hoje no tutor. Volta amanhã!', details: { limit: 'tutor_messages_day' } });
    }
    if (thread.context_pages.length >= TUTOR_CONTEXT_PAGES_CAP) {
      throw new ApiFailure('invalid_request', { message: 'Essa conversa ficou longa. Começa uma nova conversa com o resumo dela.' });
    }
    const history = await db
      .from('tutor_messages')
      .select('id, role, content, raw_content, retrieval, mode, created_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true })
      .limit(TUTOR_THREAD_MESSAGE_CAP + 1);
    if (history.error) throw history.error;
    const past = history.data as Array<Record<string, unknown>>;
    if (past.length >= TUTOR_THREAD_MESSAGE_CAP) {
      throw new ApiFailure('invalid_request', { message: 'Essa conversa ficou longa. Começa uma nova conversa com o resumo dela.' });
    }
    if (past.some((m) => m.id === input.client_message_id)) {
      throw new ApiFailure('already_exists', { message: 'Essa pergunta já foi respondida.' });
    }

    // Retrieval (TUT-01): routed by the map for a topic thread, otherwise full-text search over the thread's documents.
    const candidateSubjects = [...new Set([thread.subject_id, ...(thread.goal_id ? await goalSubjects(db, thread.goal_id) : [])].filter((v): v is string => !!v))];
    const subjectIds = await readableSubjects(db, userId, candidateSubjects);
    const docs = await documentsFor(db, subjectIds);
    const sent = new Set(thread.context_pages.map((p) => `${p.document_id}|${p.page}`));
    const query = searchTerms(input.message);
    let method: 'fts' | 'router' | 'fixed' = 'fts';
    const hits = thread.scope_type === 'topic' || thread.scope_type === 'passage' ? [] : await ftsPages(db, [...docs.keys()], query);
    if ((thread.scope_type === 'topic' || thread.scope_type === 'capture') && thread.node_id) {
      const sources = await db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', thread.node_id).is('deleted_at', null);
      if (sources.error) throw sources.error;
      method = 'router';
      for (const s of sources.data as Array<{ document_id: string; page_start: number; page_end: number }>) {
        for (let p = s.page_start; p <= s.page_end; p += 1) hits.push({ document_id: s.document_id, page_number: p, text: null });
      }
    }
    const pagesByDoc = selectNewPages(hits, sent);
    const { prepared, stored } = await prepareTurnSlices(deps, docs, pagesByDoc);
    const newPages = stored.reduce((n, s) => n + s.pages.length, 0);

    // Replay of earlier turns: the same documents, in the same order, with the stored text.
    const cache = new Map<string, string>();
    const historySources: DocumentSlice[] = [];
    const replay: Array<{ role: 'user' | 'assistant' | 'system'; content: unknown }> = [];
    for (const m of past) {
      if (m.role === 'user') {
        const storedSlices = ((m.retrieval as { slices?: StoredSlice[] } | null)?.slices ?? []) as StoredSlice[];
        const pdf = await slicesFromStored(deps, storedSlices, cache);
        for (const s of storedSlices) historySources.push({ id: s.row_id, documentId: s.document_id, title: s.title, pages: s.pages });
        const blocks = documentBlocks(pdf).blocks.map((b) => ({ ...b, citations: { enabled: true } }));
        const raw = (m.raw_content as { body?: string; mode_note?: string | null; system_notes?: string[] } | null) ?? null;
        replay.push({ role: 'user', content: [...blocks, textBlock(raw?.body ?? (m.content as string))] });
        const notes = raw?.system_notes ?? (raw?.mode_note ? [raw.mode_note] : []);
        for (const note of notes) replay.push({ role: 'system', content: note });
      } else if (m.role === 'assistant') {
        replay.push({ role: 'assistant', content: m.raw_content });
      }
    }

    const task = getTask('tutor.turn');
    const scopeLabel = subject?.name ?? 'Seu material';
    const captureText = thread.capture_id ? await captureTranscription(db, thread.capture_id) : null;
    const built = task.build({
      mode: input.mode === 'answer' ? 'Responder' : input.mode === 'socratic' ? 'Socrático' : 'Me testa',
      modeChanged: thread.mode !== input.mode && past.length > 0,
      history: replay,
      newSlices: prepared.map((p) => ({ documentId: p.documentId, title: p.title, pages: p.pages, source: { type: 'base64', media_type: 'application/pdf', data: p.base64 } }) as PdfSlice),
      message: input.message,
      scope: {
        kind: thread.scope_type,
        label: scopeLabel,
        passageText: thread.passage?.text ?? null,
        captureText,
      },
      socraticAttempts: 0,
      meTestaNodeKeys: [],
      contentLanguage: subject?.content_language ?? 'pt-BR',
      languageSubject: subject?.is_language_subject ?? false,
      voice: input.voice ?? false,
    });

    const budgetCtx = budgetCtxFor(subject, userId, input.voice ? 'TUT-06' : 'TUT-01', 'user', { nodeId: thread.node_id });
    const session = await openStream(
      claudeDepsFor(deps),
      toTaskCall({ built, taskId: 'tutor.turn', ctx: budgetCtx, historySources: [...historySources] }),
    );

    const assistantId = deps.newId();
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, thread_id: thread.id, message_id: assistantId });
      if (newPages > 0) writer.send('status', { key: 'tutor.searching_pages', params: { pages: newPages } });
      let distress = false;
      const { result } = await pumpStream(writer, session, {
        transform: (t) => {
          if (t.includes(DISTRESS_MARKER)) distress = true;
          return t.split(DISTRESS_MARKER).join('');
        },
      });
      const usage = await ctx.usagePct();
      if (result.status === 'refused' || result.status === 'invalid_output') {
        writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: usage });
        return;
      }
      const display = result.text.split(DISTRESS_MARKER).join('').trim();
      const citations = citationsForStorage(result.citations);
      // raw_content keeps the exact text sent (replayed verbatim, ai-pipeline §6.6) plus the mode note, if any.
      const userRaw = { body: sentBody(built), slices: stored, system_notes: systemNotes(built) };
      const userWrite = await db.from('tutor_messages').insert({
        id: input.client_message_id,
        thread_id: thread.id,
        user_id: userId,
        role: 'user',
        content: input.message,
        raw_content: userRaw,
        mode: input.mode,
        scope_snapshot: { type: thread.scope_type },
        retrieval: { method, pages_added: newPages, slices: stored },
        voice: input.voice ?? false,
      });
      if (userWrite.error) throw userWrite.error;
      const toolEvents = result.toolUses.map((t) => ({ name: t.name, payload: t.input }));
      const assistantWrite = await db.from('tutor_messages').insert({
        id: assistantId,
        thread_id: thread.id,
        user_id: userId,
        role: 'assistant',
        content: display,
        raw_content: result.content,
        citations,
        mode: input.mode,
        retrieval: { method, pages_added: newPages },
        tool_events: toolEvents,
        status: result.status === 'truncated' ? 'interrupted' : 'complete',
        safety_flag: distress ? 'distress' : null,
      });
      if (assistantWrite.error) throw assistantWrite.error;
      for (const event of toolEvents) writer.send('tool', event);

      const contextPages = [...thread.context_pages, ...stored.flatMap((s) => s.pages.map((p) => ({ document_id: s.document_id, page: p })))];
      const updated = await db
        .from('tutor_threads')
        .update({ context_pages: contextPages, mode: input.mode, last_message_at: ctx.now.toISOString(), title: thread.title ?? input.message.slice(0, 60) })
        .eq('id', thread.id);
      if (updated.error) throw updated.error;

      writer.send('done', {
        stop_reason: stopReasonOf(result.status),
        usage_pct_today: usage,
        result: { message_id: assistantId, thread_id: thread.id, citations },
      });
    });
  },
});

async function goalSubjects(db: SupabaseClient, goalId: string): Promise<string[]> {
  const { data, error } = await db.from('exams').select('subject_id').eq('goal_id', goalId).is('deleted_at', null);
  if (error) throw error;
  return (data as Array<{ subject_id: string | null }>).map((e) => e.subject_id).filter((v): v is string => !!v);
}

/** Subjects the student can read (IDOR: a goal's exam can point at a subject the student no longer sees). */
async function readableSubjects(db: SupabaseClient, userId: string, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const subject = await loadSubject(db, id);
    if (subject && (await canReadSubject(db, userId, subject))) out.push(id);
  }
  return out;
}

/** The text block of the last user turn as sent to Claude (the composed body, not the student's raw message). */
function sentBody(built: BuiltPrompt): string {
  for (let i = built.messages.length - 1; i >= 0; i -= 1) {
    const m = built.messages[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    const block = [...m.content].reverse().find((b) => b.type === 'text');
    if (block && block.type === 'text') return block.text;
  }
  return '';
}

/**
 * Mid-conversation system messages appended after the new user turn ("Modo atual: …", "Modo voz: …"), in
 * order, so the replay of this turn is identical (ai-pipeline §6.6).
 */
function systemNotes(built: BuiltPrompt): string[] {
  const notes: string[] = [];
  for (let i = built.messages.length - 1; i >= 0; i -= 1) {
    const m = built.messages[i]!;
    if (m.role === 'user') break; // the notes follow the new turn, so stop at the first user turn
    if (m.role === 'system' && typeof m.content === 'string') notes.unshift(m.content);
  }
  return notes;
}

/** CAM-01.4: the capture's transcription, kept in the thread's context as data. */
async function captureTranscription(db: SupabaseClient, captureId: string): Promise<string | null> {
  const { data, error } = await db.from('camera_captures').select('confirmed_text, transcription').eq('id', captureId).maybeSingle();
  if (error) throw error;
  return ((data?.confirmed_text as string | null) ?? (data?.transcription as string | null) ?? null)?.slice(0, 6000) ?? null;
}

export default handler;
