// Ensine o Lucas server helpers (INT-02, spec 12 §7.2–7.3, ai-pipeline §6.6). The hidden plan, the evaluation
// state and the replay turns live in teaching_sessions columns the client cannot select. Document blocks of the
// first turn are stored as references to document_slices and rebuilt byte-for-byte on replay, so the cached
// prefix stays identical and no PDF bytes are kept in the row.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentMap, RawTurn } from '@studify/prompts';
import {
  initialLucasState,
  type LucasEvaluationState,
  type LucasPlan,
  type LucasTurnEvaluation,
  type SourcePage,
} from '@studify/shared';
import type { StoredSlice } from '../shared/retrieval.ts';
import { downloadBytes } from '../shared/storage.ts';
import { toBase64 } from '../shared/slices.ts';

/** Model-facing plan (doc labels, concept keys), as returned by lucas.plan. */
export interface ModelPlan {
  key_concepts: Array<{ id: string; statement: string; concept_key: string | null; source_pages: Array<{ doc: string; page_start: number; page_end: number }> }>;
  misconceptions: Array<{
    id: string;
    lucas_belief: string;
    correct_concept: string;
    fix_criteria: string[];
    trigger: 'early' | 'mid' | 'late';
    source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
  }>;
  naive_questions: string[];
}

/** teaching_sessions.plan (server only). */
export interface StoredPlan {
  model: ModelPlan;
  scoring: LucasPlan;
  documents: DocumentMap;
  slices: StoredSlice[];
}

export interface TeachingRow {
  id: string;
  user_id: string;
  subject_id: string;
  node_id: string;
  length: 'short' | 'full';
  plan: StoredPlan;
  messages: Array<{ role: 'student' | 'lucas'; text: string; at: string }>;
  raw_turns: RawTurn[];
  evaluation_state: LucasEvaluationState;
  turn_count: number;
  score: number | null;
  rubric: Record<string, number> | null;
  gaps: unknown[] | null;
  errors_taught: unknown[] | null;
  teach_back: string | null;
  status: 'active' | 'finished' | 'abandoned';
  deleted_at: string | null;
}

export async function loadOwnSession(db: SupabaseClient, userId: string, sessionId: string): Promise<TeachingRow | null> {
  const { data, error } = await db.from('teaching_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) throw error;
  const row = data as TeachingRow | null;
  if (!row || row.user_id !== userId || row.deleted_at) return null;
  return row;
}

/** Doc-label page refs to stored SourcePages; refs outside the sent pages are dropped (TRU-01.2). */
export function mapPages(refs: ReadonlyArray<{ doc: string; page_start: number; page_end: number }>, documents: DocumentMap): SourcePage[] {
  const out: SourcePage[] = [];
  for (const r of refs) {
    const documentId = documents.labels[r.doc];
    const allowed = documents.allowedPages[r.doc] ?? [];
    if (!documentId || r.page_end < r.page_start) continue;
    let ok = true;
    for (let p = r.page_start; p <= r.page_end; p++) if (!allowed.includes(p)) ok = false;
    if (ok) out.push({ document_id: documentId, page_start: r.page_start, page_end: r.page_end });
  }
  return out;
}

/** Scoring plan: shared LucasPlan with SourcePages and concept node ids (concept keys are node ids). */
export function scoringPlan(model: ModelPlan, documents: DocumentMap, opener: string, conceptIds: ReadonlySet<string>): LucasPlan {
  return {
    key_concepts: model.key_concepts.map((k) => ({
      id: k.id,
      statement: k.statement,
      node_id: k.concept_key && conceptIds.has(k.concept_key) ? k.concept_key : null,
      source_pages: mapPages(k.source_pages, documents),
    })),
    misconceptions: model.misconceptions.map((m) => ({
      id: m.id,
      lucas_belief: m.lucas_belief,
      correct_concept: m.correct_concept,
      fix_criteria: m.fix_criteria,
      trigger: m.trigger,
      source_pages: mapPages(m.source_pages, documents),
    })),
    naive_questions: model.naive_questions,
    opener,
  };
}

export function startState(plan: LucasPlan): LucasEvaluationState {
  return initialLucasState(plan);
}

/** Model output of one turn → the shared evaluation (pages mapped to original pages). */
export function mapTurnEvaluation(
  evaluation: {
    misconception_updates: LucasTurnEvaluation['misconception_updates'];
    concepts_covered: LucasTurnEvaluation['concepts_covered'];
    errors_taught: Array<{ claim: string; correction: string; severity: 'minor' | 'major'; concept_id: string | null; source_pages: Array<{ doc: string; page_start: number; page_end: number }> }>;
    clarity_signals: LucasTurnEvaluation['clarity_signals'];
  },
  documents: DocumentMap,
): LucasTurnEvaluation {
  return {
    misconception_updates: evaluation.misconception_updates,
    concepts_covered: evaluation.concepts_covered,
    errors_taught: evaluation.errors_taught.map((e) => ({ ...e, source_pages: mapPages(e.source_pages, documents) })),
    clarity_signals: evaluation.clarity_signals,
  };
}

interface DocBlock {
  type: 'document';
  title: string;
  source: { type: string; data?: string; media_type?: string; slice?: number };
  [key: string]: unknown;
}

/** New turns of a built prompt, with the PDF bytes of document blocks swapped for slice references. */
export function toStoredTurns(turns: readonly RawTurn[], slices: readonly StoredSlice[]): RawTurn[] {
  return turns.map((turn) => {
    if (!Array.isArray(turn.content)) return turn;
    let docIndex = 0;
    const content = (turn.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type !== 'document') return block;
      const slice = docIndex++;
      if (slice >= slices.length) return block;
      const doc = block as unknown as DocBlock;
      return { ...doc, source: { type: 'stored_slice', slice } };
    });
    return { ...turn, content };
  });
}

/** Inverse of toStoredTurns: rebuilds base64 document sources from Storage (same bytes as the first turn). */
export async function restoreTurns(db: SupabaseClient, turns: readonly RawTurn[], slices: readonly StoredSlice[]): Promise<RawTurn[]> {
  const cache = new Map<number, string>();
  const out: RawTurn[] = [];
  for (const turn of turns) {
    if (!Array.isArray(turn.content)) {
      out.push(turn);
      continue;
    }
    const content: unknown[] = [];
    for (const block of turn.content as Array<Record<string, unknown>>) {
      const source = (block as unknown as DocBlock).source;
      if (block.type === 'document' && source?.type === 'stored_slice' && typeof source.slice === 'number') {
        const stored = slices[source.slice];
        if (!stored) continue;
        let data = cache.get(source.slice);
        if (!data) {
          data = toBase64(await downloadBytes(db, stored.storage_path));
          cache.set(source.slice, data);
        }
        content.push({ ...block, source: { type: 'base64', media_type: 'application/pdf', data } });
      } else {
        content.push(block);
      }
    }
    out.push({ ...turn, content });
  }
  return out;
}

/** The [[APOIO]] marker of the crisis protocol (spec 13 §8.11) is removed from the text shown to the student. */
export const SUPPORT_MARKER = '[[APOIO]]';

export function stripSupport(text: string): { text: string; support: boolean } {
  const support = text.includes(SUPPORT_MARKER);
  return { text: text.split(SUPPORT_MARKER).join('').trim(), support };
}
