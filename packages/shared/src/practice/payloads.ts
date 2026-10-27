// Question payloads (questions.payload, spec 05 §8.1) and learner responses (attempt_answers.response).
// These schemas are the single contract for offline grading on device and for the Edge Functions and
// worker. The mobile UI writes responses in exactly the shapes below.
import { z } from 'zod';
import type { QuestionType } from '../core/index.ts';
import { parseDecimal } from './text.ts';

const Id = z.string().min(1);
const Text = z.string().min(1);
const Item = z.object({ id: Id, text: Text });

/** §8.2 validator: "todas as anteriores" / "nenhuma das anteriores" style alternatives are rejected. */
const ABSOLUTE_ALTERNATIVE = /\b(todas|nenhuma)\s+(as\s+|das\s+)?(alternativas\s+)?anteriores\b/i;

/** Multi-select somatória values (PRA-01.1): 01, 02, 04, 08, 16, 32, 64. */
const SOMATORIA_VALUES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32, 64]);

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isSubset(sub: readonly string[], sup: readonly string[]): boolean {
  const allowed = new Set(sup);
  return sub.every((value) => allowed.has(value));
}

function check(ctx: z.RefinementCtx, ok: boolean, message: string, path: (string | number)[] = []): void {
  if (!ok) ctx.addIssue({ code: 'custom', message, path });
}

// ---------------------------------------------------------------- payloads (§8.1)

const McqOptionSchema = z.object({
  id: Id,
  text: Text,
  rationale: Text, // §8.2: rationale required for every option
  misconception_concept_id: z.string().min(1).nullish(),
});

/** mcq_single: 5 alternatives by default, 4 when the source style uses 4 (PRA-01.1). */
export const McqSinglePayloadSchema = z
  .object({
    options: z.array(McqOptionSchema).min(4).max(5),
    correct: Id,
  })
  .superRefine((p, ctx) => {
    check(ctx, unique(p.options.map((o) => o.id)), 'duplicate option id', ['options']);
    check(ctx, p.options.some((o) => o.id === p.correct), 'correct is not an option id', ['correct']);
    check(ctx, !p.options.some((o) => ABSOLUTE_ALTERNATIVE.test(o.text)), 'absolute alternative is not allowed', ['options']);
  });

const MultiSelectOptionSchema = z.object({
  id: Id,
  text: Text,
  rationale: Text,
  value: z.number().int().positive().nullish(),
});

/** multi_select: "assinale as corretas"; somatória when `somatoria` is true (values 1…64). */
export const MultiSelectPayloadSchema = z
  .object({
    options: z.array(MultiSelectOptionSchema).min(3).max(7),
    correct: z.array(Id).min(1),
    somatoria: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const ids = p.options.map((o) => o.id);
    check(ctx, unique(ids), 'duplicate option id', ['options']);
    check(ctx, unique(p.correct), 'duplicate correct id', ['correct']);
    check(ctx, isSubset(p.correct, ids), 'correct contains a non-option id', ['correct']);
    check(ctx, !p.options.some((o) => ABSOLUTE_ALTERNATIVE.test(o.text)), 'absolute alternative is not allowed', ['options']);
    if (p.somatoria) {
      const values = p.options.map((o) => o.value);
      check(
        ctx,
        values.every((v): v is number => v !== null && v !== undefined && SOMATORIA_VALUES.has(v)),
        'somatória options need values 1, 2, 4, 8, 16, 32 or 64',
        ['options'],
      );
      const present = values.filter((v): v is number => v !== null && v !== undefined);
      check(ctx, new Set(present).size === present.length, 'somatória values must be distinct', ['options']);
    }
  });

export const TrueFalsePayloadSchema = z.object({
  statement: Text,
  correct: z.boolean(),
  justification: Text,
});

const BlankSchema = z.object({
  id: z.number().int().min(1),
  accepted: z.array(Text).min(1),
});

/** fill_blank: `text` holds `{{n}}` placeholders, one per blank (ids are numbers in the payload). */
export const FillBlankPayloadSchema = z
  .object({
    text: Text,
    blanks: z.array(BlankSchema).min(1),
  })
  .superRefine((p, ctx) => {
    const ids = p.blanks.map((b) => b.id);
    check(ctx, new Set(ids).size === ids.length, 'duplicate blank id', ['blanks']);
    const placeholders = (p.text.match(/\{\{\d+\}\}/g) ?? []).map((m) => Number(m.slice(2, -2)));
    const sameSet = placeholders.length === ids.length && placeholders.every((n) => ids.includes(n));
    check(ctx, sameSet, 'text placeholders must match blank ids', ['text']);
  });

/** numeric: value within tolerance; unit only matters when `unit_required` (PRA-01.7). */
export const NumericPayloadSchema = z
  .object({
    answer: z.number(),
    tolerance_abs: z.number().nonnegative().nullish(),
    tolerance_rel: z.number().nonnegative().nullish(),
    unit: Text.nullish(),
    unit_required: z.boolean(),
  })
  .superRefine((p, ctx) => {
    check(ctx, !p.unit_required || p.unit != null, 'unit_required needs a unit', ['unit']);
  });

/** matching: every left item is paired exactly once; right items may be extra distractors. */
export const MatchingPayloadSchema = z
  .object({
    left: z.array(Item).min(1),
    right: z.array(Item).min(1),
    pairs: z.array(z.tuple([Id, Id])).min(1),
  })
  .superRefine((p, ctx) => {
    const leftIds = p.left.map((i) => i.id);
    const rightIds = p.right.map((i) => i.id);
    check(ctx, unique(leftIds), 'duplicate left id', ['left']);
    check(ctx, unique(rightIds), 'duplicate right id', ['right']);
    const lefts = p.pairs.map((pair) => pair[0]);
    check(ctx, isSubset(lefts, leftIds) && p.pairs.every((pair) => rightIds.includes(pair[1])), 'pair references an unknown item', ['pairs']);
    check(ctx, unique(lefts) && lefts.length === leftIds.length, 'every left item needs exactly one pair', ['pairs']);
  });

/** ordering: `correct_order` is a permutation of the item ids. */
export const OrderingPayloadSchema = z
  .object({
    items: z.array(Item).min(2),
    correct_order: z.array(Id).min(2),
  })
  .superRefine((p, ctx) => {
    const ids = p.items.map((i) => i.id);
    check(ctx, unique(ids), 'duplicate item id', ['items']);
    const isPermutation = unique(p.correct_order) && p.correct_order.length === ids.length && isSubset(p.correct_order, ids);
    check(ctx, isPermutation, 'correct_order must list every item once', ['correct_order']);
  });

const RubricItemSchema = z.object({
  id: Id,
  criterion: Text,
  points: z.number().nonnegative(),
});

/** short_answer: AI-graded against the rubric (PRA-01.6). */
export const ShortAnswerPayloadSchema = z.object({
  model_answer: Text,
  rubric: z.array(RubricItemSchema).min(1),
  max_points: z.number().positive(),
  key_terms: z.array(Text).default([]),
});

/** essay_question: questão dissertativa, AI-graded (PRA-07). */
export const EssayQuestionPayloadSchema = z.object({
  model_answer: Text,
  rubric: z.array(RubricItemSchema).min(1),
  max_points: z.number().positive(),
  expected_lines: z.number().int().positive().nullish(),
});

/** PRA-06.2 error types. Generated items store one of these keys in `error_type`; the UI shows the label. */
export const FIND_ERROR_TYPES = {
  conceitual: 'Erro de conceito',
  calculo: 'Erro de cálculo',
  sinal: 'Erro de sinal',
  unidade: 'Erro de unidade',
  definicao: 'Definição errada',
  data_nome: 'Data ou nome errado',
  causa_efeito: 'Causa e efeito trocados',
} as const;
export type FindErrorType = keyof typeof FIND_ERROR_TYPES;

/** find_error: exactly one planted segment, or `null` for "Não tem erro" (PRA-06.1). */
export const FindErrorPayloadSchema = z
  .object({
    segments: z.array(Item).min(2),
    error_segment_id: Id.nullable(),
    error_type: Text,
    explanation: Text,
    corrected_text: Text,
  })
  .superRefine((p, ctx) => {
    const ids = p.segments.map((s) => s.id);
    check(ctx, unique(ids), 'duplicate segment id', ['segments']);
    check(
      ctx,
      p.error_segment_id === null || ids.includes(p.error_segment_id),
      'error_segment_id must be a segment id or null',
      ['error_segment_id'],
    );
  });

/** problem: numeric and choice answers are graded locally; expression answers are pending (PRA-08.4). */
export const ProblemPayloadSchema = z
  .object({
    given: z.record(z.string(), z.union([z.number(), z.string()])),
    final_answer: z.union([z.number(), Text]),
    answer_format: z.enum(['numeric', 'expression', 'choice']),
    tolerance: z.number().nonnegative().nullish(),
    check_expression: Text.nullish(),
    solution_steps: z.array(Text),
    hints: z.array(Text).length(3),
  })
  .superRefine((p, ctx) => {
    if (p.answer_format === 'numeric') {
      check(ctx, parseDecimal(String(p.final_answer)) !== null, 'numeric problem needs a numeric final_answer', ['final_answer']);
    }
  });

export type McqSinglePayload = z.output<typeof McqSinglePayloadSchema>;
export type MultiSelectPayload = z.output<typeof MultiSelectPayloadSchema>;
export type TrueFalsePayload = z.output<typeof TrueFalsePayloadSchema>;
export type FillBlankPayload = z.output<typeof FillBlankPayloadSchema>;
export type NumericPayload = z.output<typeof NumericPayloadSchema>;
export type MatchingPayload = z.output<typeof MatchingPayloadSchema>;
export type OrderingPayload = z.output<typeof OrderingPayloadSchema>;
export type FindErrorPayload = z.output<typeof FindErrorPayloadSchema>;
export type ProblemPayload = z.output<typeof ProblemPayloadSchema>;

export const QUESTION_PAYLOAD_SCHEMAS = {
  mcq_single: McqSinglePayloadSchema,
  multi_select: MultiSelectPayloadSchema,
  true_false: TrueFalsePayloadSchema,
  fill_blank: FillBlankPayloadSchema,
  numeric: NumericPayloadSchema,
  matching: MatchingPayloadSchema,
  ordering: OrderingPayloadSchema,
  short_answer: ShortAnswerPayloadSchema,
  essay_question: EssayQuestionPayloadSchema,
  find_error: FindErrorPayloadSchema,
  problem: ProblemPayloadSchema,
} satisfies Record<QuestionType, z.ZodType>;

export type QuestionPayloadByType = { [K in QuestionType]: z.output<(typeof QUESTION_PAYLOAD_SCHEMAS)[K]> };
export type QuestionPayload = QuestionPayloadByType[QuestionType];

/** Envelope form `{type, payload}` for transport; `questions.payload` itself has no type field. */
export const QuestionPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq_single'), payload: McqSinglePayloadSchema }),
  z.object({ type: z.literal('multi_select'), payload: MultiSelectPayloadSchema }),
  z.object({ type: z.literal('true_false'), payload: TrueFalsePayloadSchema }),
  z.object({ type: z.literal('fill_blank'), payload: FillBlankPayloadSchema }),
  z.object({ type: z.literal('numeric'), payload: NumericPayloadSchema }),
  z.object({ type: z.literal('matching'), payload: MatchingPayloadSchema }),
  z.object({ type: z.literal('ordering'), payload: OrderingPayloadSchema }),
  z.object({ type: z.literal('short_answer'), payload: ShortAnswerPayloadSchema }),
  z.object({ type: z.literal('essay_question'), payload: EssayQuestionPayloadSchema }),
  z.object({ type: z.literal('find_error'), payload: FindErrorPayloadSchema }),
  z.object({ type: z.literal('problem'), payload: ProblemPayloadSchema }),
]);

/** Parses an untrusted payload for a known type. Throws a ZodError when it is invalid. */
export function parseQuestionPayload<T extends QuestionType>(type: T, raw: unknown): QuestionPayloadByType[T] {
  return (QUESTION_PAYLOAD_SCHEMAS[type] as z.ZodType).parse(raw) as QuestionPayloadByType[T];
}

// ---------------------------------------------------------------- responses (attempt_answers.response)

export const McqSingleResponseSchema = z.strictObject({ choice: Id });
export const MultiSelectResponseSchema = z.strictObject({ choices: z.array(Id) });
export const TrueFalseResponseSchema = z.strictObject({ value: z.boolean() });
export const FillBlankResponseSchema = z.strictObject({ blanks: z.record(z.string(), z.string()) });
export const NumericResponseSchema = z.strictObject({ number: z.number(), unit: z.string().nullish() });
export const MatchingResponseSchema = z.strictObject({ pairs: z.array(z.tuple([Id, Id])) });
export const OrderingResponseSchema = z.strictObject({ order: z.array(Id) });
/** Shared by short_answer and essay_question. */
export const TextResponseSchema = z.strictObject({ text: z.string() });
/** PRA-06.3: the tapped segment, plus the optional error type and free-text explanation of the follow-up step. */
export const FindErrorResponseSchema = z.strictObject({
  segment_id: Id.nullable(),
  error_type: z.string().max(40).optional(),
  explanation: z.string().max(1000).optional(),
});
export const ProblemResponseSchema = z.strictObject({ answer: z.string() });

export const QUESTION_RESPONSE_SCHEMAS = {
  mcq_single: McqSingleResponseSchema,
  multi_select: MultiSelectResponseSchema,
  true_false: TrueFalseResponseSchema,
  fill_blank: FillBlankResponseSchema,
  numeric: NumericResponseSchema,
  matching: MatchingResponseSchema,
  ordering: OrderingResponseSchema,
  short_answer: TextResponseSchema,
  essay_question: TextResponseSchema,
  find_error: FindErrorResponseSchema,
  problem: ProblemResponseSchema,
} satisfies Record<QuestionType, z.ZodType>;

export type QuestionResponseByType = { [K in QuestionType]: z.output<(typeof QUESTION_RESPONSE_SCHEMAS)[K]> };

/** Any learner response. The shapes are disjoint (strict objects), so the union needs no type tag. */
export const QuestionResponseSchema = z.union([
  McqSingleResponseSchema,
  MultiSelectResponseSchema,
  TrueFalseResponseSchema,
  FillBlankResponseSchema,
  NumericResponseSchema,
  MatchingResponseSchema,
  OrderingResponseSchema,
  TextResponseSchema,
  FindErrorResponseSchema,
  ProblemResponseSchema,
]);
export type QuestionResponse = z.output<typeof QuestionResponseSchema>;

/** Parses an untrusted response for a known type. Throws a ZodError when the shape is wrong. */
export function parseQuestionResponse<T extends QuestionType>(type: T, raw: unknown): QuestionResponseByType[T] {
  return (QUESTION_RESPONSE_SCHEMAS[type] as z.ZodType).parse(raw) as QuestionResponseByType[T];
}
