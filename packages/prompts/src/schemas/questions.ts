import { z } from 'zod';
import { BloomLevel, ConceptKey, Difficulty, DocPageRef, RemediationCard, SourcePages } from './common.ts';

// Question payloads per spec 05 §8.1 and the question types of data-model `questions.type`.
// Phase 0–2 generation uses mcq_single … essay_question; find_error and problem are kept so
// the canonical type union stays complete for Phase 3 tasks and the predicted test.

const OptionId = z.string().regex(/^[A-E]$/, 'alternativa A–E');

function sequentialOptionIds(ids: readonly string[]): string | null {
  const expected = ['A', 'B', 'C', 'D', 'E'].slice(0, ids.length);
  return ids.every((id, i) => id === expected[i]) ? null : 'alternativas devem ser A, B, C… em ordem';
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const Alternative = z.strictObject({
  id: OptionId,
  text: z.string().min(1).max(300),
  rationale: z.string().min(1).max(300),
  misconception_concept_key: ConceptKey.nullable(),
});

export const McqSinglePayload = z
  .strictObject({
    options: z.array(Alternative).min(4).max(5),
    correct: OptionId,
  })
  .superRefine((p, ctx) => {
    const ids = p.options.map((o) => o.id);
    const seq = sequentialOptionIds(ids);
    if (seq) ctx.addIssue({ code: 'custom', message: seq, path: ['options'] });
    if (!ids.includes(p.correct)) ctx.addIssue({ code: 'custom', message: 'correct não está entre as alternativas', path: ['correct'] });
  });

export const MultiSelectPayload = z
  .strictObject({
    options: z.array(Alternative.extend({ value: z.number().int().min(1).nullable() })).min(4).max(5),
    correct: z.array(OptionId).min(2).max(4),
    somatoria: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const ids = p.options.map((o) => o.id);
    const seq = sequentialOptionIds(ids);
    if (seq) ctx.addIssue({ code: 'custom', message: seq, path: ['options'] });
    if (!unique(p.correct)) ctx.addIssue({ code: 'custom', message: 'correct com repetidos', path: ['correct'] });
    if (p.correct.some((c) => !ids.includes(c))) ctx.addIssue({ code: 'custom', message: 'correct fora das alternativas', path: ['correct'] });
    if (p.correct.length >= ids.length) ctx.addIssue({ code: 'custom', message: 'nem todas as alternativas podem ser corretas', path: ['correct'] });
  });

export const TrueFalsePayload = z.strictObject({
  statement: z.string().min(1).max(400),
  correct: z.boolean(),
  justification: z.string().min(1).max(400),
});

export const FillBlankPayload = z
  .strictObject({
    text: z.string().min(1).max(600),
    blanks: z
      .array(z.strictObject({ id: z.number().int().min(1), accepted: z.array(z.string().min(1).max(80)).min(1).max(6) }))
      .min(1)
      .max(5),
  })
  .superRefine((p, ctx) => {
    const placeholders = [...p.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const blankIds = p.blanks.map((b) => b.id);
    if (!unique(blankIds.map(String))) ctx.addIssue({ code: 'custom', message: 'ids de lacuna repetidos', path: ['blanks'] });
    const same = placeholders.length === blankIds.length && placeholders.every((n) => blankIds.includes(n));
    if (!same) ctx.addIssue({ code: 'custom', message: 'lacunas do texto e de blanks não batem', path: ['text'] });
  });

export const NumericPayload = z
  .strictObject({
    answer: z.number(),
    tolerance_abs: z.number().min(0).nullable(),
    tolerance_rel: z.number().min(0).nullable(),
    unit: z.string().min(1).max(20).nullable(),
    unit_required: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.unit_required && !p.unit) ctx.addIssue({ code: 'custom', message: 'unit_required exige unit', path: ['unit'] });
  });

const MatchItem = z.strictObject({ id: z.string().min(1).max(8), text: z.string().min(1).max(200) });

export const MatchingPayload = z
  .strictObject({
    left: z.array(MatchItem).min(2).max(6),
    right: z.array(MatchItem).min(2).max(8),
    pairs: z.array(z.strictObject({ left: z.string().min(1).max(8), right: z.string().min(1).max(8) })).min(2).max(6),
  })
  .superRefine((p, ctx) => {
    const leftIds = p.left.map((i) => i.id);
    const rightIds = p.right.map((i) => i.id);
    if (!unique(leftIds) || !unique(rightIds)) ctx.addIssue({ code: 'custom', message: 'ids repetidos', path: ['left'] });
    if (p.pairs.length !== leftIds.length) ctx.addIssue({ code: 'custom', message: 'cada item da esquerda precisa de um par', path: ['pairs'] });
    const used = p.pairs.map((pair) => pair.left);
    if (!unique(used) || leftIds.some((id) => !used.includes(id))) ctx.addIssue({ code: 'custom', message: 'pares não cobrem a esquerda', path: ['pairs'] });
    if (p.pairs.some((pair) => !rightIds.includes(pair.right))) ctx.addIssue({ code: 'custom', message: 'par aponta para item inexistente', path: ['pairs'] });
  });

export const OrderingPayload = z
  .strictObject({
    items: z.array(MatchItem).min(3).max(7),
    correct_order: z.array(z.string().min(1).max(8)).min(3).max(7),
  })
  .superRefine((p, ctx) => {
    const ids = p.items.map((i) => i.id);
    const sameSet = p.correct_order.length === ids.length && ids.every((id) => p.correct_order.includes(id)) && unique(p.correct_order);
    if (!sameSet) ctx.addIssue({ code: 'custom', message: 'correct_order deve ser uma permutação dos itens', path: ['correct_order'] });
  });

const RubricItem = z.strictObject({
  id: z.string().min(1).max(8),
  criterion: z.string().min(1).max(200),
  points: z.number().positive().max(10),
});

export const ShortAnswerPayload = z
  .strictObject({
    model_answer: z.string().min(1).max(1200),
    rubric: z.array(RubricItem).min(1).max(6),
    max_points: z.number().positive().max(10),
    key_terms: z.array(z.string().min(1).max(60)).max(8),
  })
  .superRefine((p, ctx) => {
    const total = p.rubric.reduce((sum, r) => sum + r.points, 0);
    if (Math.abs(total - p.max_points) > 1e-9) ctx.addIssue({ code: 'custom', message: 'soma da rubrica diferente de max_points', path: ['rubric'] });
  });

export const EssayPayload = z
  .strictObject({
    model_answer: z.string().min(1).max(3000),
    rubric: z.array(RubricItem).min(1).max(8),
    max_points: z.number().positive().max(100),
    expected_lines: z.number().int().min(5).max(30),
  })
  .superRefine((p, ctx) => {
    const total = p.rubric.reduce((sum, r) => sum + r.points, 0);
    if (Math.abs(total - p.max_points) > 1e-9) ctx.addIssue({ code: 'custom', message: 'soma da rubrica diferente de max_points', path: ['rubric'] });
  });

export const FindErrorPayload = z
  .strictObject({
    segments: z.array(MatchItem).min(3).max(8),
    error_segment_id: z.string().min(1).max(8).nullable(),
    error_type: z.string().min(1).max(60),
    explanation: z.string().min(1).max(600),
    corrected_text: z.string().min(1).max(400).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.error_segment_id && !p.segments.some((s) => s.id === p.error_segment_id)) {
      ctx.addIssue({ code: 'custom', message: 'error_segment_id fora dos segmentos', path: ['error_segment_id'] });
    }
  });

export const ProblemPayload = z.strictObject({
  given: z.array(z.strictObject({ name: z.string().min(1).max(40), value: z.string().min(1).max(80) })).max(10),
  final_answer: z.string().min(1).max(200),
  answer_format: z.enum(['numeric', 'expression', 'choice']),
  tolerance: z.number().min(0).nullable(),
  check_expression: z.string().max(300).nullable(),
  solution_steps: z.array(z.string().min(1).max(400)).min(1).max(12),
  hints: z.array(z.string().min(1).max(200)).length(3),
});

/** Fields every question carries (PRA-01.2). The payload is type-specific. */
const common = {
  stem: z.string().min(1).max(2000),
  stimulus_md: z.string().max(3000), // empty when the question needs no figure or table
  explanation: z.string().min(1).max(1200),
  bloom_level: BloomLevel,
  difficulty: Difficulty,
  concept_keys: z.array(ConceptKey).min(1).max(3),
  source_pages: SourcePages,
  remediation_card: RemediationCard,
};

export const QuestionVariants = {
  mcq_single: z.strictObject({ type: z.literal('mcq_single'), ...common, payload: McqSinglePayload }),
  multi_select: z.strictObject({ type: z.literal('multi_select'), ...common, payload: MultiSelectPayload }),
  true_false: z.strictObject({ type: z.literal('true_false'), ...common, payload: TrueFalsePayload }),
  fill_blank: z.strictObject({ type: z.literal('fill_blank'), ...common, payload: FillBlankPayload }),
  numeric: z.strictObject({ type: z.literal('numeric'), ...common, payload: NumericPayload }),
  matching: z.strictObject({ type: z.literal('matching'), ...common, payload: MatchingPayload }),
  ordering: z.strictObject({ type: z.literal('ordering'), ...common, payload: OrderingPayload }),
  short_answer: z.strictObject({ type: z.literal('short_answer'), ...common, payload: ShortAnswerPayload }),
  essay_question: z.strictObject({ type: z.literal('essay_question'), ...common, payload: EssayPayload }),
  find_error: z.strictObject({ type: z.literal('find_error'), ...common, payload: FindErrorPayload }),
  problem: z.strictObject({ type: z.literal('problem'), ...common, payload: ProblemPayload }),
};

export type QuestionType = keyof typeof QuestionVariants;
export const QUESTION_TYPES = Object.keys(QuestionVariants) as QuestionType[];

export const QuestionSchema = z.union([
  QuestionVariants.mcq_single,
  QuestionVariants.multi_select,
  QuestionVariants.true_false,
  QuestionVariants.fill_blank,
  QuestionVariants.numeric,
  QuestionVariants.matching,
  QuestionVariants.ordering,
  QuestionVariants.short_answer,
  QuestionVariants.essay_question,
  QuestionVariants.find_error,
  QuestionVariants.problem,
]);

/** Objective types only: used by the Modo Desespero diagnostic (spec 07 §8.10.4). */
export const ObjectiveQuestionSchema = z.union([
  QuestionVariants.mcq_single,
  QuestionVariants.true_false,
  QuestionVariants.fill_blank,
]);

export type Question = z.infer<typeof QuestionSchema>;

// What the model writes. A union of the question variants is too large for structured outputs (the API
// answers "The compiled grammar is too large" even for three variants), so the model output has the
// shared fields once and the type-specific payload as a JSON string. decodeQuestion parses and checks
// it against the variant schema; a question that fails is dropped on its own, not the whole response.

function questionDraft<const T extends readonly [QuestionType, ...QuestionType[]]>(types: T) {
  return z.strictObject({
    type: z.enum(types),
    ...common,
    payload_json: z.string().min(2).max(8000), // the payload object of `type`, serialized as JSON
  });
}

export const QuestionDraftSchema = questionDraft(QUESTION_TYPES as [QuestionType, ...QuestionType[]]);
export type QuestionDraft = z.infer<typeof QuestionDraftSchema>;

export const TopicQuestions = z.strictObject({
  questions: z.array(QuestionDraftSchema).min(1).max(20),
});

export const SingleQuestion = z.strictObject({ question: QuestionDraftSchema });

export const DiagnosticQuestions = z.strictObject({
  questions: z.array(questionDraft(['mcq_single', 'true_false', 'fill_blank'])).min(1).max(12),
});

export type DecodedQuestion = { ok: true; question: Question } | { ok: false; reason: 'payload_not_json' | 'payload_invalid' };

type JsonNode = { type?: string | string[]; anyOf?: JsonNode[]; properties?: Record<string, JsonNode>; items?: JsonNode };

const payloadSchemas = new Map<QuestionType, JsonNode>();

function payloadSchema(type: QuestionType): JsonNode {
  let schema = payloadSchemas.get(type);
  if (!schema) {
    const shape = QuestionVariants[type].shape.payload;
    schema = z.toJSONSchema(shape, { io: 'output', unrepresentable: 'any' }) as JsonNode;
    payloadSchemas.set(type, schema);
  }
  return schema;
}

function allowsNull(node: JsonNode): boolean {
  return node.type === 'null' || (Array.isArray(node.type) && node.type.includes('null')) || (node.anyOf ?? []).some(allowsNull);
}

/**
 * Repairs what free-form JSON loses against the schema: an omitted nullable key becomes null and a numeric
 * string becomes a number where the schema wants one. Anything else is left for the variant schema to judge.
 */
function normalizePayload(node: JsonNode, value: unknown): unknown {
  const branch = node.anyOf?.find((b) => b.type !== 'null') ?? node;
  if (branch.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, child] of Object.entries(branch.properties)) {
      if (out[key] === undefined) {
        if (allowsNull(child)) out[key] = null;
      } else {
        out[key] = normalizePayload(child, out[key]);
      }
    }
    return out;
  }
  if (branch.items && Array.isArray(value)) return value.map((item) => normalizePayload(branch.items as JsonNode, item));
  if ((branch.type === 'number' || branch.type === 'integer') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

/** The checked question for a model draft: payload_json parsed and validated against the variant of `type`. */
export function decodeQuestion(draft: QuestionDraft): DecodedQuestion {
  let payload: unknown;
  try {
    payload = JSON.parse(draft.payload_json);
  } catch {
    return { ok: false, reason: 'payload_not_json' };
  }
  const { payload_json: _json, ...rest } = draft;
  const parsed = QuestionVariants[draft.type].safeParse({ ...rest, payload: normalizePayload(payloadSchema(draft.type), payload) });
  return parsed.success ? { ok: true, question: parsed.data as Question } : { ok: false, reason: 'payload_invalid' };
}
