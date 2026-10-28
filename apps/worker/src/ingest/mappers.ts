// Output mapping (spec 01 §7–8, specs 02/04/05 payloads): model output keyed by document labels (D1…)
// and concept keys (c1…) becomes rows keyed by UUIDs, original page numbers and the payload shapes the
// app reads. Every function here is pure: the caller writes the rows.
import { normalizePageRanges, type SourcePage } from '@studify/shared';
import { normalizeTerm } from './text.ts';

export interface LabelMap {
  /** Document label (D1, D2…) to document id. */
  labels: Record<string, string>;
  /** Document label to the original pages that were sent for it. */
  allowedPages: Record<string, readonly number[]>;
}

export interface PageRefInput {
  doc: string;
  page_start: number;
  page_end: number;
}

/**
 * Converts `source_pages` into SourcePages (data-model §1.2). Any reference outside the pages that were
 * sent invalidates the whole item (TRU-01.2): the result is null and the caller drops the item.
 */
export function toSourcePages(refs: readonly PageRefInput[], map: LabelMap): SourcePage[] | null {
  if (refs.length === 0) return null;
  const byDoc = new Map<string, Array<{ page_start: number; page_end: number }>>();
  for (const ref of refs) {
    const documentId = map.labels[ref.doc];
    const allowed = map.allowedPages[ref.doc];
    if (!documentId || !allowed) return null;
    if (ref.page_end < ref.page_start) return null;
    for (let page = ref.page_start; page <= ref.page_end; page++) {
      if (!allowed.includes(page)) return null;
    }
    const list = byDoc.get(documentId) ?? [];
    list.push({ page_start: ref.page_start, page_end: ref.page_end });
    byDoc.set(documentId, list);
  }
  const out: SourcePage[] = [];
  for (const [documentId, ranges] of byDoc) {
    for (const range of normalizePageRanges(ranges)) out.push({ document_id: documentId, ...range });
  }
  return out;
}

/** Range of pages covered by a set of source pages (for the topic's node_sources and the chip text). */
export function sourcePagesToRanges(pages: readonly SourcePage[]): Array<{ document_id: string; page_start: number; page_end: number }> {
  return pages.map((p) => ({ document_id: p.document_id, page_start: p.page_start, page_end: p.page_end }));
}

/** Concept lookup: model concept keys (c1…) to node ids for one topic. */
export function resolveConceptKeys(keys: readonly string[], conceptIdByKey: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const id = conceptIdByKey.get(key);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Questions (spec 05 §8.1)
// ---------------------------------------------------------------------------

export interface QuestionDraft {
  type: string;
  stem: string;
  stimulus_md: string | null;
  explanation: string;
  bloom_level: string;
  difficulty: number;
  concept_keys: string[];
  source_pages: PageRefInput[];
  remediation_card: { front: string; back: string };
  payload: Record<string, any>;
}

export interface QuestionRow {
  type: string;
  stem: string;
  stimulus: { markdown: string } | null;
  payload: Record<string, unknown>;
  explanation: string;
  bloom_level: string;
  difficulty: number;
  concept_ids: string[];
  source_pages: SourcePage[];
  has_math: boolean;
}

export type MapResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Maps one generated question to a questions row. The payload follows spec 05 §8.1 exactly, with
 * one addition: `remediation_card` (PRA-02.3) is kept inside the payload, since the table has no
 * column for it. Multiple-choice items have 5 options (A–E) by default and 4 when the source uses 4 (spec 05 PRA-01.1).
 */
export function mapQuestion(
  draft: QuestionDraft,
  ctx: { labels: LabelMap; conceptIdByKey: ReadonlyMap<string, string>; conceptKeyOfId?: ReadonlyMap<string, string> },
): MapResult<QuestionRow> {
  const conceptIds = resolveConceptKeys(draft.concept_keys, ctx.conceptIdByKey);
  if (conceptIds.length === 0) return { ok: false, reason: 'concept_not_in_topic' };
  const sources = toSourcePages(draft.source_pages, ctx.labels);
  if (!sources) return { ok: false, reason: 'source_pages_out_of_range' };

  const payloadResult = toPayload(draft, ctx.conceptIdByKey);
  if (!payloadResult.ok) return payloadResult;

  const payload = { ...payloadResult.value, remediation_card: draft.remediation_card };
  const text = [draft.stem, draft.stimulus_md ?? '', draft.explanation].join(' ');
  return {
    ok: true,
    value: {
      type: draft.type,
      stem: draft.stem,
      stimulus: draft.stimulus_md ? { markdown: draft.stimulus_md } : null,
      payload,
      explanation: draft.explanation,
      bloom_level: draft.bloom_level,
      difficulty: draft.difficulty,
      concept_ids: conceptIds,
      source_pages: sources,
      has_math: text.includes('$'),
    },
  };
}

function toPayload(draft: QuestionDraft, conceptIdByKey: ReadonlyMap<string, string>): MapResult<Record<string, unknown>> {
  const p = draft.payload;
  switch (draft.type) {
    case 'mcq_single': {
      const options = (p.options as Array<Record<string, any>>) ?? [];
      if (options.length < 4 || options.length > 5) return { ok: false, reason: 'mcq_options_count' };
      return {
        ok: true,
        value: {
          options: options.map((o) => ({
            id: o.id,
            text: o.text,
            rationale: o.rationale,
            ...(o.misconception_concept_key
              ? { misconception_concept_id: conceptIdByKey.get(o.misconception_concept_key) ?? null }
              : {}),
          })),
          correct: p.correct,
        },
      };
    }
    case 'multi_select': {
      const options = (p.options as Array<Record<string, any>>) ?? [];
      if (options.length < 4 || options.length > 5) return { ok: false, reason: 'mcq_options_count' };
      return {
        ok: true,
        value: {
          options: options.map((o) => ({
            id: o.id,
            text: o.text,
            rationale: o.rationale,
            value: o.value ?? null,
            ...(o.misconception_concept_key
              ? { misconception_concept_id: conceptIdByKey.get(o.misconception_concept_key) ?? null }
              : {}),
          })),
          correct: p.correct,
          somatoria: p.somatoria === true,
        },
      };
    }
    case 'true_false':
      return { ok: true, value: { statement: p.statement, correct: p.correct, justification: p.justification } };
    case 'fill_blank':
      return { ok: true, value: { text: p.text, blanks: p.blanks } };
    case 'numeric':
      return {
        ok: true,
        value: {
          answer: p.answer,
          tolerance_abs: p.tolerance_abs,
          tolerance_rel: p.tolerance_rel,
          unit: p.unit,
          unit_required: p.unit_required,
        },
      };
    case 'matching':
      return {
        ok: true,
        value: {
          left: p.left,
          right: p.right,
          // Spec 05 §8.1 stores pairs as [left, right] tuples.
          pairs: (p.pairs as Array<{ left: string; right: string }>).map((pair) => [pair.left, pair.right]),
        },
      };
    case 'ordering':
      return { ok: true, value: { items: p.items, correct_order: p.correct_order } };
    case 'short_answer':
      return {
        ok: true,
        value: { model_answer: p.model_answer, rubric: p.rubric, max_points: p.max_points, key_terms: p.key_terms ?? [] },
      };
    case 'essay_question':
      return {
        ok: true,
        value: { model_answer: p.model_answer, rubric: p.rubric, max_points: p.max_points, expected_lines: p.expected_lines },
      };
    default:
      return { ok: false, reason: 'type_not_generated' };
  }
}

// ---------------------------------------------------------------------------
// Cards (spec 04 §8.1)
// ---------------------------------------------------------------------------

export interface CardDraftInput {
  type: 'basic' | 'cloze' | 'reverse';
  front: string;
  back: string;
  cloze_text: string | null;
  concept_key: string;
  source_pages: PageRefInput[];
  difficulty_estimate: number;
}

export interface CardRow {
  type: 'basic' | 'cloze' | 'reverse';
  front: string;
  back: string;
  concept_id: string;
  source_pages: SourcePage[];
  cloze_index: number | null;
  /** Shared by the sibling cards of one cloze sentence; null for single cards. */
  sibling_key: number | null;
  has_math: boolean;
}

const CLOZE_INDEX = /\{\{c(\d+)::/g;

/** Distinct cN indexes of a cloze sentence, ascending. */
export function clozeIndexes(clozeText: string): number[] {
  const found = new Set<number>();
  for (const m of clozeText.matchAll(CLOZE_INDEX)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** The hidden text of deletion cN (several cN deletions joined), without the optional ::hint. */
export function clozeAnswer(clozeText: string, n: number): string {
  const answers = [...clozeText.matchAll(/\{\{c(\d+)::([^}]+?)(?:::([^}]+))?\}\}/g)]
    .filter((m) => Number(m[1]) === n)
    .map((m) => (m[2] ?? '').trim());
  return answers.join(' … ');
}

/**
 * Maps one drafted card to rows. A cloze sentence with several deletions produces one sibling card per
 * cN (spec 04 §5.1). Returns an empty list when the card cannot be placed.
 */
export function mapCard(draft: CardDraftInput, ctx: { labels: LabelMap; conceptIdByKey: ReadonlyMap<string, string> }): MapResult<CardRow[]> {
  const conceptId = ctx.conceptIdByKey.get(draft.concept_key);
  if (!conceptId) return { ok: false, reason: 'concept_not_in_topic' };
  const sources = toSourcePages(draft.source_pages, ctx.labels);
  if (!sources) return { ok: false, reason: 'source_pages_out_of_range' };

  if (draft.type === 'cloze' && draft.cloze_text) {
    const indexes = clozeIndexes(draft.cloze_text);
    if (indexes.length === 0) return { ok: false, reason: 'cloze_without_deletion' };
    const siblingKey = indexes.length > 1 ? indexes[0] ?? null : null;
    return {
      ok: true,
      value: indexes.map((n) => ({
        type: 'cloze' as const,
        // Spec 04 §5: the source text with {{cN::…}} markers is the front; back is the hidden answer.
        front: draft.cloze_text as string,
        // Each sibling hides a different term, so its back is that term, not the one the model wrote for c1.
        back: indexes.length > 1 ? clozeAnswer(draft.cloze_text as string, n) || draft.back : draft.back,
        concept_id: conceptId,
        source_pages: sources,
        cloze_index: n,
        sibling_key: siblingKey,
        has_math: draft.front.includes('$') || draft.back.includes('$'),
      })),
    };
  }
  return {
    ok: true,
    value: [
      {
        type: draft.type === 'cloze' ? 'basic' : draft.type,
        front: draft.front,
        back: draft.back,
        concept_id: conceptId,
        source_pages: sources,
        cloze_index: null,
        sibling_key: null,
        has_math: draft.front.includes('$') || draft.back.includes('$'),
      },
    ],
  };
}

/** Normalized front, for duplicate checks against existing cards of the subject (spec 04 §8.1). */
export function cardFrontKey(front: string): string {
  return normalizeTerm(front.replace(/\{\{c\d+::([^{}]+)\}\}/g, '$1'));
}

// ---------------------------------------------------------------------------
// Glossary (spec 02 LRN-02)
// ---------------------------------------------------------------------------

export interface GlossaryDraftInput {
  term: string;
  definition: string;
  example: string | null;
  aliases: string[];
  concept_key: string;
  source_pages: PageRefInput[];
}

export interface GlossaryRow {
  term: string;
  normalized_term: string;
  aliases: string[];
  definition: string;
  example: string | null;
  node_id: string;
  source_pages: SourcePage[];
}

export function mapGlossaryTerm(
  draft: GlossaryDraftInput,
  ctx: { labels: LabelMap; conceptIdByKey: ReadonlyMap<string, string>; topicId: string },
): MapResult<GlossaryRow> {
  const normalized = normalizeTerm(draft.term);
  if (!normalized) return { ok: false, reason: 'empty_term' };
  const sources = toSourcePages(draft.source_pages, ctx.labels);
  if (!sources) return { ok: false, reason: 'source_pages_out_of_range' };
  return {
    ok: true,
    value: {
      term: draft.term,
      normalized_term: normalized,
      aliases: draft.aliases.filter((a) => normalizeTerm(a) !== normalized).slice(0, 6),
      definition: draft.definition,
      example: draft.example,
      node_id: ctx.conceptIdByKey.get(draft.concept_key) ?? ctx.topicId,
      source_pages: sources,
    },
  };
}

// ---------------------------------------------------------------------------
// Ache o Erro (PRA-06) and problem sets (PRA-08)
// ---------------------------------------------------------------------------

export interface FindErrorDraft {
  statement_kind: 'statement' | 'paragraph' | 'solution';
  segments: Array<{ id: string; text: string }>;
  error_segment_id: string | null;
  error_type: string | null;
  explanation: string;
  corrected_text: string | null;
  concept_keys: string[];
  difficulty: number;
  source_pages: PageRefInput[];
}

const FIND_ERROR_STEM: Record<FindErrorDraft['statement_kind'], string> = {
  statement: 'Ache o erro na afirmação.',
  paragraph: 'Ache o trecho errado do parágrafo.',
  solution: 'Ache o passo errado da resolução.',
};

/** Ache o Erro item → `find_error` question (PRA-06.2). "Não tem erro" items keep a null error segment. */
export function mapFindError(draft: FindErrorDraft, ctx: { labels: LabelMap; conceptIdByKey: ReadonlyMap<string, string> }): MapResult<QuestionRow> {
  const conceptIds = resolveConceptKeys(draft.concept_keys, ctx.conceptIdByKey);
  if (conceptIds.length === 0) return { ok: false, reason: 'concept_not_in_topic' };
  const sources = toSourcePages(draft.source_pages, ctx.labels);
  if (!sources) return { ok: false, reason: 'source_pages_out_of_range' };
  const ids = draft.segments.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate_segment' };
  if (draft.error_segment_id !== null && !ids.includes(draft.error_segment_id)) return { ok: false, reason: 'error_segment_unknown' };
  const noError = draft.error_segment_id === null;
  const text = draft.segments.map((s) => s.text).join(' ');
  return {
    ok: true,
    value: {
      type: 'find_error',
      stem: FIND_ERROR_STEM[draft.statement_kind],
      stimulus: null,
      payload: {
        segments: draft.segments,
        error_segment_id: draft.error_segment_id,
        error_type: noError ? 'sem_erro' : (draft.error_type ?? 'conceitual'),
        explanation: draft.explanation,
        corrected_text: noError ? draft.explanation : (draft.corrected_text ?? draft.explanation),
        statement_kind: draft.statement_kind,
      },
      explanation: draft.explanation,
      bloom_level: 'evaluate',
      difficulty: draft.difficulty,
      concept_ids: conceptIds,
      source_pages: sources,
      has_math: text.includes('$'),
    },
  };
}

export interface ProblemDraft {
  statement: string;
  given: Array<{ name: string; value: string }>;
  final_answer: string;
  answer_format: 'numeric' | 'expression' | 'choice';
  unit: string | null;
  tolerance: number | null;
  check_expression: string | null;
  solution_steps: string[];
  hints: string[];
  difficulty: number;
  concept_keys: string[];
  source_pages: PageRefInput[];
}

export interface WorkedExampleDraft {
  statement: string;
  steps: string[];
  answer: string;
}

/**
 * Problem → `problem` question (PRA-08.2). Every item must pass the deterministic consistency check
 * (spec 05 §8.9: check_expression with `given` reproduces final_answer); one that fails is dropped.
 */
export function mapProblem(
  draft: ProblemDraft,
  ctx: { labels: LabelMap; conceptIdByKey: ReadonlyMap<string, string>; consistent: (p: { given: Record<string, number | string>; final_answer: string; answer_format: ProblemDraft['answer_format']; tolerance: number | null; check_expression: string | null }) => boolean },
): MapResult<QuestionRow> {
  const conceptIds = resolveConceptKeys(draft.concept_keys, ctx.conceptIdByKey);
  if (conceptIds.length === 0) return { ok: false, reason: 'concept_not_in_topic' };
  const sources = toSourcePages(draft.source_pages, ctx.labels);
  if (!sources) return { ok: false, reason: 'source_pages_out_of_range' };
  if (draft.hints.length !== 3) return { ok: false, reason: 'hints_not_three' };
  const given: Record<string, number | string> = {};
  for (const g of draft.given) {
    const n = Number(g.value.replace(',', '.'));
    given[g.name] = Number.isFinite(n) && g.value.trim() !== '' ? n : g.value;
  }
  const finalAnswer = draft.answer_format === 'numeric' ? draft.final_answer.replace(',', '.') : draft.final_answer;
  if (!ctx.consistent({ given, final_answer: finalAnswer, answer_format: draft.answer_format, tolerance: draft.tolerance, check_expression: draft.check_expression })) {
    return { ok: false, reason: 'problem_inconsistent' };
  }
  const text = [draft.statement, ...draft.solution_steps].join(' ');
  return {
    ok: true,
    value: {
      type: 'problem',
      stem: draft.statement,
      stimulus: null,
      payload: {
        given,
        final_answer: draft.answer_format === 'numeric' ? Number(finalAnswer) : finalAnswer,
        answer_format: draft.answer_format,
        unit: draft.unit,
        tolerance: draft.tolerance,
        check_expression: draft.check_expression,
        solution_steps: draft.solution_steps,
        hints: draft.hints,
      },
      explanation: draft.solution_steps.join('\n'),
      bloom_level: 'apply',
      difficulty: draft.difficulty,
      concept_ids: conceptIds,
      source_pages: sources,
      has_math: text.includes('$'),
    },
  };
}

/** PRA-08.1 faded worked examples: example 2 hides its last step, example 3 its last two. */
export function fadeWorkedExamples(examples: readonly WorkedExampleDraft[]): Array<WorkedExampleDraft & { hidden_steps: number }> {
  return examples.slice(0, 3).map((e, i) => ({ ...e, hidden_steps: Math.min(i, Math.max(0, e.steps.length - 1)) }));
}
