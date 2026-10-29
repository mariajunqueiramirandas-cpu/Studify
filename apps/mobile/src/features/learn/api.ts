import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { ApiError, callFunction, streamFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';
import type { SourceRef } from '../../components';

export type NoteDepth = 'tldr' | 'study' | 'deep' | 'class_summary';
export const NOTE_DEPTHS: NoteDepth[] = ['tldr', 'study', 'deep'];

export interface Citation extends SourceRef {
  start?: number;
  end?: number;
  index?: number;
}

export interface Note {
  id: string;
  subject_id: string;
  node_id: string | null;
  depth: NoteDepth;
  body: string;
  citations: Citation[];
  status: 'pending' | 'generating' | 'ready' | 'failed' | 'superseded';
  supersedes_note_id: string | null;
  low_citation_coverage: boolean;
  updated_at: string;
}

export interface GlossaryTerm {
  id: string;
  subject_id: string;
  node_id: string | null;
  term: string;
  normalized_term: string;
  aliases: string[];
  definition: string;
  example: string | null;
  source_pages: SourceRef[];
  hidden_reason: string | null;
}

export interface CardRow {
  id: string;
  subject_id: string;
  node_id: string;
  type: 'basic' | 'cloze' | 'reverse' | 'image_occlusion';
  front: string;
  back: string;
  cloze_index: number | null;
  source_pages: SourceRef[];
  origin: 'generated' | 'user' | 'from_mistake' | 'from_tutor';
  personal_for_user_id: string | null;
  status: 'active' | 'archived';
  hidden_reason: string | null;
  version: number;
}

export function useNotes(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId, 'notes'],
    enabled: !!nodeId,
    queryFn: () =>
      rows<Note>(supabase.from('notes').select('*').eq('node_id', nodeId!).in('status', ['pending', 'generating', 'ready']).is('deleted_at', null)),
    refetchInterval: (q) => ((q.state.data ?? []).some((n) => n.status !== 'ready') ? 6000 : false),
  });
}

export function useNote(noteId: string | undefined) {
  return useQuery({
    queryKey: ['note', noteId],
    enabled: !!noteId,
    queryFn: () => row<Note>(supabase.from('notes').select('*').eq('id', noteId!).maybeSingle()),
  });
}

/** LRN-01.4: tldr/study are queued by the worker; "Gerar aprofundado" streams via SSE. */
export async function requestNote(nodeId: string, depth: NoteDepth, regenerate = false) {
  return callFunction<{ node_id: string; depth: NoteDepth; regenerate?: boolean }, { note_id: string; status: string }>(
    'note-generate',
    { node_id: nodeId, depth, regenerate },
    { idempotencyKey: uuidv7() },
  );
}

export function streamDeepNote(nodeId: string, handlers: StreamHandlers) {
  return streamFunction('note-generate', { node_id: nodeId, depth: 'deep' }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

export type ExplainStyle = 'simpler' | 'analogy' | 'example' | 'step_by_step';
export const EXPLAIN_STYLES: ExplainStyle[] = ['simpler', 'analogy', 'example', 'step_by_step'];

export interface StreamHandlers {
  onMeta?: (data: Record<string, unknown>) => void;
  onDelta?: (text: string) => void;
  onCitation?: (c: Citation) => void;
  /** Progress the server reports while it works (`operation.progress`, `tutor.searching_pages`…), with its params. */
  onStatus?: (key: string, params?: Record<string, unknown>) => void;
  onTool?: (name: string, payload: unknown) => void;
  onDone?: (data: { stop_reason?: string; usage_pct_today?: number; result?: unknown }) => void;
  /** The failure, whatever ended the stream: the server's error, or the network/deadline (transport.ts). */
  onError?: (err: ApiError) => void;
}

export function toEventHandler(h: StreamHandlers) {
  return (ev: { event: string; data: unknown }) => {
    const d = ev.data as Record<string, unknown>;
    switch (ev.event) {
      case 'meta':
        h.onMeta?.(d);
        break;
      case 'delta':
        h.onDelta?.(String(d.text ?? ''));
        break;
      case 'citation':
        h.onCitation?.(d as unknown as Citation);
        break;
      case 'status':
        h.onStatus?.(String(d.key ?? ''), (d.params as Record<string, unknown> | undefined) ?? undefined);
        break;
      case 'tool':
        h.onTool?.(String(d.name ?? ''), d.payload);
        break;
      case 'done':
        h.onDone?.(d as { stop_reason?: string; usage_pct_today?: number; result?: unknown });
        break;
      case 'error': {
        // An ApiError, so screens show what happened (messageFor) instead of the generic copy.
        const e = d as { code?: string; message?: string; status?: number; resets_at?: string; retry_after_s?: number; details?: Record<string, unknown> };
        h.onError?.(new ApiError(String(e.code ?? 'unknown'), Number(e.status ?? 0), String(e.message ?? ''), { resetsAt: e.resets_at, retryAfterS: e.retry_after_s, details: e.details }));
        break;
      }
    }
  };
}

/** LRN-03 "Explica de outro jeito" (SSE; cache hits stream instantly). */
export function streamExplain(
  target: { target_type: 'note_paragraph' | 'concept' | 'glossary_term' | 'question_explanation' | 'card_back' | 'trail_step'; target_id: string; paragraph_index?: number },
  style: ExplainStyle,
  handlers: StreamHandlers,
  forceNew = false,
) {
  return streamFunction('explain', { ...target, style, force_new: forceNew }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

export async function sendExplanationFeedback(userId: string, explanationId: string, helpful: boolean) {
  await supabase.from('explanation_feedback').insert({ user_id: userId, explanation_id: explanationId, helpful });
}

export function useGlossary(subjectId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['subject', subjectId, 'glossary'],
    enabled: !!subjectId,
    queryFn: async () => {
      const [terms, overrides] = await Promise.all([
        rows<GlossaryTerm>(supabase.from('glossary_terms').select('*').eq('subject_id', subjectId!).is('deleted_at', null).is('hidden_reason', null).order('normalized_term')),
        rows<{ term_id: string; definition: string }>(supabase.from('glossary_term_overrides').select('term_id,definition').eq('user_id', userId!)),
      ]);
      const ov = new Map(overrides.map((o) => [o.term_id, o.definition]));
      return terms.map((t) => (ov.has(t.id) ? { ...t, definition: ov.get(t.id)! } : t));
    },
  });
}

export function useSubjectCards(subjectId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['subject', subjectId, 'cards'],
    enabled: !!subjectId && !!userId,
    queryFn: async () => {
      const [cards, states, overrides] = await Promise.all([
        rows<CardRow>(supabase.from('cards').select('*').eq('subject_id', subjectId!).is('deleted_at', null).eq('status', 'active')),
        rows<{ card_id: string; due: string; state: number; suspended: boolean; hidden: boolean; is_leech: boolean }>(
          supabase.from('card_states').select('card_id,due,state,suspended,hidden,is_leech').eq('user_id', userId!).eq('subject_id', subjectId!),
        ),
        rows<{ card_id: string; front: string | null; back: string | null }>(supabase.from('card_overrides').select('card_id,front,back').eq('user_id', userId!)),
      ]);
      const st = new Map(states.map((s) => [s.card_id, s]));
      const ov = new Map(overrides.map((o) => [o.card_id, o]));
      return cards
        .filter((c) => !c.personal_for_user_id || c.personal_for_user_id === userId)
        .map((c) => {
          const o = ov.get(c.id);
          return { ...c, front: o?.front ?? c.front, back: o?.back ?? c.back, overridden: !!o, state: st.get(c.id) ?? null };
        });
    },
  });
}

export function useNodeCounts(nodeId: string | undefined) {
  return useQuery({
    queryKey: ['node', nodeId, 'counts'],
    enabled: !!nodeId,
    queryFn: async () => {
      const [cards, questions] = await Promise.all([
        supabase.from('cards').select('id', { count: 'exact', head: true }).eq('node_id', nodeId!).is('deleted_at', null),
        supabase.from('questions').select('id', { count: 'exact', head: true }).eq('node_id', nodeId!).is('deleted_at', null).eq('status', 'active'),
      ]);
      return { cards: cards.count ?? 0, questions: questions.count ?? 0 };
    },
  });
}

/** MEM-01: user card. In a shared subject it is private to the creator (R8). */
export async function createUserCard(userId: string, input: { subjectId: string; nodeId: string; type: 'basic' | 'cloze' | 'reverse'; front: string; back: string; sourcePages?: SourceRef[]; origin?: CardRow['origin']; shared: boolean }) {
  const id = uuidv7();
  const { error } = await supabase.from('cards').insert({
    id,
    subject_id: input.subjectId,
    node_id: input.nodeId,
    type: input.type,
    front: input.front,
    back: input.back,
    has_math: /\$[^$]+\$/.test(input.front + input.back),
    source_pages: input.sourcePages ?? [],
    origin: input.origin ?? 'user',
    created_by: userId,
    personal_for_user_id: input.shared ? userId : null,
  });
  if (error) throw error;
  return id;
}

/** Edits to shared cards become per-user overrides, never silent changes for everyone (architecture §3.2). */
export async function saveCardEdit(userId: string, card: CardRow, front: string, back: string) {
  const own = card.origin === 'user' && (card.personal_for_user_id === userId || card.personal_for_user_id == null);
  if (own) {
    const { error } = await supabase.from('cards').update({ front, back, has_math: /\$[^$]+\$/.test(front + back) }).eq('id', card.id);
    if (!error) return 'updated' as const;
  }
  const { error } = await supabase
    .from('card_overrides')
    .upsert({ user_id: userId, card_id: card.id, front, back, updated_at: new Date().toISOString() }, { onConflict: 'user_id,card_id' });
  if (error) throw error;
  return 'override' as const;
}

export async function setCardFlag(userId: string, cardId: string, patch: { suspended?: boolean; hidden?: boolean }) {
  const { error } = await supabase.from('card_states').update(patch).eq('user_id', userId).eq('card_id', cardId);
  if (error) throw error;
}

export async function draftCard(input: { subject_id: string; node_id?: string; selection: string; source: 'note' | 'pdf'; document_id?: string; page?: number }) {
  return callFunction<typeof input, { front: string; back: string; type: 'basic' | 'cloze'; source_pages: SourceRef[] }>('card-draft', input, { idempotencyKey: uuidv7() });
}

export async function generateMoreCards(nodeId: string) {
  return callFunction<{ node_id: string }, { card_ids: string[] }>('cards-generate-more', { node_id: nodeId }, { idempotencyKey: uuidv7() });
}

export async function generateMoreQuestions(nodeId: string, count = 10) {
  return callFunction<{ node_id: string; count: number }, { question_ids: string[] }>('questions-generate-more', { node_id: nodeId, count }, { idempotencyKey: uuidv7() });
}

export async function recordTopicRead(userId: string, nodeId: string, depth: NoteDepth, seconds: number) {
  await supabase.from('topic_reads').insert({ id: uuidv7(), user_id: userId, node_id: nodeId, depth, read_at: new Date().toISOString(), seconds });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (key: unknown[]) => qc.invalidateQueries({ queryKey: key });
}
