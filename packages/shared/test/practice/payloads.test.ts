import { describe, expect, it } from 'vitest';
import {
  FillBlankPayloadSchema,
  MatchingPayloadSchema,
  McqSinglePayloadSchema,
  MultiSelectPayloadSchema,
  NumericPayloadSchema,
  OrderingPayloadSchema,
  ProblemPayloadSchema,
  QUESTION_PAYLOAD_SCHEMAS,
  QUESTION_RESPONSE_SCHEMAS,
  QuestionPayloadSchema,
  QuestionResponseSchema,
  FindErrorPayloadSchema,
  parseQuestionPayload,
  parseQuestionResponse,
} from '../../src/practice/index.ts';
import { QUESTION_TYPE } from '../../src/core/index.ts';
import * as F from './fixtures.ts';

describe('question payload schemas (spec 05 §8.1)', () => {
  it('accept the valid fixture of every type', () => {
    const fixtures: Record<string, unknown> = {
      mcq_single: F.MCQ,
      multi_select: F.MULTI,
      true_false: F.TRUE_FALSE,
      fill_blank: F.FILL_BLANK,
      numeric: F.NUMERIC,
      matching: F.MATCHING,
      ordering: F.ORDERING,
      short_answer: F.SHORT_ANSWER,
      essay_question: F.ESSAY,
      find_error: F.FIND_ERROR,
      problem: F.PROBLEM_NUMERIC,
    };
    for (const type of QUESTION_TYPE) {
      expect(() => parseQuestionPayload(type, fixtures[type])).not.toThrow();
    }
  });

  it('has one schema per question type and the envelope accepts each', () => {
    expect(Object.keys(QUESTION_PAYLOAD_SCHEMAS).sort()).toEqual([...QUESTION_TYPE].sort());
    const envelope = QuestionPayloadSchema.safeParse({ type: 'numeric', payload: F.NUMERIC });
    expect(envelope.success).toBe(true);
    expect(QuestionPayloadSchema.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
  });

  it('defaults key_terms to an empty list', () => {
    const { key_terms: _ignored, ...withoutKeyTerms } = F.SHORT_ANSWER;
    const parsed = parseQuestionPayload('short_answer', withoutKeyTerms);
    expect(parsed.key_terms).toEqual([]);
  });

  describe('§8.2 validator rules', () => {
    it('rejects "todas as anteriores" and "nenhuma das anteriores" alternatives', () => {
      const withAbsolute = {
        ...F.MCQ,
        options: [...F.MCQ.options.slice(0, 4), { id: 'E', text: 'Todas as anteriores', rationale: 'x' }],
      };
      expect(McqSinglePayloadSchema.safeParse(withAbsolute).success).toBe(false);
      const nenhuma = {
        ...F.MCQ,
        options: [...F.MCQ.options.slice(0, 4), { id: 'E', text: 'Nenhuma das alternativas anteriores', rationale: 'x' }],
      };
      expect(McqSinglePayloadSchema.safeParse(nenhuma).success).toBe(false);
      expect(McqSinglePayloadSchema.safeParse(F.MCQ).success).toBe(true);
    });

    it('rejects an alternative without a rationale', () => {
      const bad = { ...F.MCQ, options: [{ id: 'A', text: 'x' }, ...F.MCQ.options.slice(1)] };
      expect(McqSinglePayloadSchema.safeParse(bad).success).toBe(false);
    });

    it('accepts a 4-alternative mcq and rejects 3 or 6 alternatives', () => {
      expect(McqSinglePayloadSchema.safeParse({ ...F.MCQ, options: F.MCQ.options.slice(0, 4) }).success).toBe(true);
      expect(McqSinglePayloadSchema.safeParse({ ...F.MCQ, options: F.MCQ.options.slice(0, 3) }).success).toBe(false);
      const six = [...F.MCQ.options, { id: 'F', text: 'x', rationale: 'y' }];
      expect(McqSinglePayloadSchema.safeParse({ ...F.MCQ, options: six }).success).toBe(false);
    });

    it('rejects a correct letter that is not an option, and duplicate option ids', () => {
      expect(McqSinglePayloadSchema.safeParse({ ...F.MCQ, correct: 'Z' }).success).toBe(false);
      const dup = { ...F.MCQ, options: [F.MCQ.options[0], ...F.MCQ.options.slice(0, 4)] };
      expect(McqSinglePayloadSchema.safeParse(dup).success).toBe(false);
    });

    it('validates somatória values when somatoria is true', () => {
      const somatoria = {
        ...F.MULTI,
        somatoria: true,
        options: F.MULTI.options.map((o, i) => ({ ...o, value: 2 ** i })),
      };
      expect(MultiSelectPayloadSchema.safeParse(somatoria).success).toBe(true);
      const badValue = { ...somatoria, options: somatoria.options.map((o) => ({ ...o, value: 3 })) };
      expect(MultiSelectPayloadSchema.safeParse(badValue).success).toBe(false);
    });

    it('rejects a fill_blank whose placeholders do not match blank ids', () => {
      const missing = { ...F.FILL_BLANK, blanks: [F.FILL_BLANK.blanks[0]!] };
      expect(FillBlankPayloadSchema.safeParse(missing).success).toBe(false);
    });

    it('requires a unit when unit_required is true', () => {
      expect(NumericPayloadSchema.safeParse({ answer: 1, unit_required: true }).success).toBe(false);
      expect(NumericPayloadSchema.safeParse({ answer: 1, unit: 'm', unit_required: true }).success).toBe(true);
    });

    it('rejects matching with an unmatched left item', () => {
      const unmatched = { ...F.MATCHING, pairs: F.MATCHING.pairs.slice(0, 2) };
      expect(MatchingPayloadSchema.safeParse(unmatched).success).toBe(false);
      const unknownRight = { ...F.MATCHING, pairs: [['L1', 'R9'], ['L2', 'R1'], ['L3', 'R3']] };
      expect(MatchingPayloadSchema.safeParse(unknownRight).success).toBe(false);
      expect(MatchingPayloadSchema.safeParse(F.MATCHING).success).toBe(true);
    });

    it('requires ordering to be a permutation of the items', () => {
      expect(OrderingPayloadSchema.safeParse({ ...F.ORDERING, correct_order: ['I3', 'I1'] }).success).toBe(false);
      expect(OrderingPayloadSchema.safeParse({ ...F.ORDERING, correct_order: ['I3', 'I3', 'I1'] }).success).toBe(false);
      expect(OrderingPayloadSchema.safeParse(F.ORDERING).success).toBe(true);
    });

    it('requires an error segment that exists, or null for "Não tem erro"', () => {
      expect(FindErrorPayloadSchema.safeParse({ ...F.FIND_ERROR, error_segment_id: 'S9' }).success).toBe(false);
      expect(FindErrorPayloadSchema.safeParse(F.FIND_ERROR_NONE).success).toBe(true);
    });

    it('requires three hints and a numeric final answer for numeric problems', () => {
      expect(ProblemPayloadSchema.safeParse({ ...F.PROBLEM_NUMERIC, hints: ['a', 'b'] }).success).toBe(false);
      expect(ProblemPayloadSchema.safeParse({ ...F.PROBLEM_NUMERIC, final_answer: 'quatro' }).success).toBe(false);
      expect(ProblemPayloadSchema.safeParse(F.PROBLEM_NUMERIC).success).toBe(true);
    });
  });
});

describe('learner response schemas (attempt_answers.response)', () => {
  it('accepts the exact shapes the mobile UI writes', () => {
    const shapes: Array<[keyof typeof QUESTION_RESPONSE_SCHEMAS, unknown]> = [
      ['mcq_single', { choice: 'A' }],
      ['multi_select', { choices: ['A', 'D'] }],
      ['true_false', { value: true }],
      ['fill_blank', { blanks: { '1': 'ATP' } }],
      ['numeric', { number: 9.8, unit: 'm/s²' }],
      ['numeric', { number: 9.8 }],
      ['matching', { pairs: [['L1', 'R3']] }],
      ['ordering', { order: ['I3', 'I1', 'I2'] }],
      ['short_answer', { text: 'resposta' }],
      ['essay_question', { text: 'dissertação' }],
      ['find_error', { segment_id: 'S3' }],
      ['find_error', { segment_id: null }],
      ['problem', { answer: '9,8' }],
    ];
    for (const [type, shape] of shapes) {
      expect(parseQuestionResponse(type, shape)).toEqual(shape);
      expect(QuestionResponseSchema.safeParse(shape).success).toBe(true);
    }
  });

  it('rejects unknown keys and wrong value types', () => {
    expect(QUESTION_RESPONSE_SCHEMAS.mcq_single.safeParse({ choice: 'A', extra: 1 }).success).toBe(false);
    expect(QUESTION_RESPONSE_SCHEMAS.true_false.safeParse({ value: 'sim' }).success).toBe(false);
    expect(QUESTION_RESPONSE_SCHEMAS.numeric.safeParse({ number: '9.8' }).success).toBe(false);
    expect(QuestionResponseSchema.safeParse({ something: 'else' }).success).toBe(false);
  });
});
