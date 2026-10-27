import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  damerauLevenshtein,
  foldAnswer,
  gradeAnswer,
  matchAcceptedAnswer,
  maxTypoDistance,
  suggestMistakeCause,
  type PracticeGradeResult,
  type QuestionPayload,
} from '../../src/practice/index.ts';
import type { QuestionType } from '../../src/core/index.ts';
import * as F from './fixtures.ts';

const grade = (type: QuestionType, payload: QuestionPayload, response: unknown): PracticeGradeResult =>
  gradeAnswer(type, payload as never, response as never);

function assertInvariants(result: PracticeGradeResult): void {
  if (result.pending) {
    expect(result.score).toBeNull();
    expect(result.correct).toBeNull();
    return;
  }
  expect(result.score).not.toBeNull();
  expect(result.score!).toBeGreaterThanOrEqual(0);
  expect(result.score!).toBeLessThanOrEqual(1);
  expect(result.correct).toBe(result.score === 1);
}

const letter = fc.constantFrom('A', 'B', 'C', 'D', 'E', 'Z', '');
const sampleIds = (ids: readonly string[]) => fc.shuffledSubarray([...ids], { minLength: 0 });

const cases: Array<{ type: QuestionType; payload: QuestionPayload; response: fc.Arbitrary<unknown> }> = [
  { type: 'mcq_single', payload: F.MCQ, response: fc.record({ choice: letter }) },
  { type: 'multi_select', payload: F.MULTI, response: fc.record({ choices: fc.uniqueArray(letter, { maxLength: 6 }) }) },
  { type: 'true_false', payload: F.TRUE_FALSE, response: fc.record({ value: fc.boolean() }) },
  {
    type: 'fill_blank',
    payload: F.FILL_BLANK,
    response: fc.record({ blanks: fc.dictionary(fc.constantFrom('1', '2', '3'), fc.string({ maxLength: 20 })) }),
  },
  {
    type: 'numeric',
    payload: F.NUMERIC,
    response: fc.record({ number: fc.double({ min: -1e4, max: 1e4, noNaN: true }), unit: fc.option(fc.string(), { nil: undefined }) }),
  },
  {
    type: 'matching',
    payload: F.MATCHING,
    response: fc.record({
      pairs: fc.array(fc.tuple(fc.constantFrom('L1', 'L2', 'L3', 'L9'), fc.constantFrom('R1', 'R2', 'R3', 'R4')), { maxLength: 6 }),
    }),
  },
  { type: 'ordering', payload: F.ORDERING, response: fc.record({ order: sampleIds(['I1', 'I2', 'I3', 'I4']) }) },
  { type: 'short_answer', payload: F.SHORT_ANSWER, response: fc.record({ text: fc.string() }) },
  { type: 'essay_question', payload: F.ESSAY, response: fc.record({ text: fc.string() }) },
  {
    type: 'find_error',
    payload: F.FIND_ERROR,
    response: fc.record({ segment_id: fc.constantFrom('S1', 'S2', 'S3', null) }),
  },
  {
    type: 'problem',
    payload: F.PROBLEM_NUMERIC,
    response: fc.record({ answer: fc.oneof(fc.double({ noNaN: true }).map(String), fc.string()) }),
  },
];

describe('grading invariants over random responses (spec 05 §8.4, PRA-01.8)', () => {
  for (const c of cases) {
    it(`${c.type}: score ∈ [0, 1], correct ⇔ score === 1, pending ⇒ no score`, () => {
      fc.assert(
        fc.property(c.response, (response) => {
          const result = grade(c.type, c.payload, response);
          assertInvariants(result);
          expect(result.typo).toBeNull();
        }),
        { numRuns: 300 },
      );
    });
  }

  it('any junk response (arbitrary JSON-like value) keeps the invariants for every type', () => {
    fc.assert(
      fc.property(fc.anything(), (response) => {
        for (const c of cases) assertInvariants(grade(c.type, c.payload, response));
      }),
      { numRuns: 200 },
    );
  });

  it('a null response scores 0 for every type', () => {
    for (const c of cases) {
      expect(grade(c.type, c.payload, null)).toEqual({ correct: false, score: 0, typo: null, pending: false });
    }
  });

  it('fill_blank: a typo note is only ever returned together with a correct answer', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 15 }), (typed) => {
        const result = grade('fill_blank', F.FILL_BLANK_TYPO, { blanks: { '1': typed } });
        if (result.typo !== null) expect(result.correct).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('suggestMistakeCause always returns one of the four causes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<1 | 2 | 3 | 4 | null>(1, 2, 3, 4, null),
        fc.double({ min: 0, max: 600, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 600, noNaN: true }), { nil: null }),
        letter,
        (confidence, timeSeconds, medianTimeSeconds, choice) => {
          const cause = suggestMistakeCause({
            type: 'mcq_single',
            stem: F.MCQ_NEG_STEM,
            payload: F.MCQ_NEG,
            response: choice === '' ? null : { choice },
            confidence,
            timeSeconds,
            medianTimeSeconds,
          });
          expect(['didnt_know', 'confused', 'careless', 'misread']).toContain(cause);
        },
      ),
    );
  });
});

describe('text matching properties (PRA-01.7)', () => {
  const word = fc.stringMatching(/^[a-z]{5,12}$/);

  it('Damerau–Levenshtein is symmetric, zero only for equal strings, and bounded by the longer length', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), fc.string({ maxLength: 10 }), (a, b) => {
        const d = damerauLevenshtein(a, b);
        expect(d).toBe(damerauLevenshtein(b, a));
        expect(d === 0).toBe(a === b);
        expect(d).toBeLessThanOrEqual(Math.max(Array.from(a).length, Array.from(b).length));
      }),
      { numRuns: 300 },
    );
  });

  it('a single deletion of a word of length ≥ 5 is accepted with the typo note', () => {
    fc.assert(
      fc.property(word, fc.nat(), (w, pos) => {
        const i = pos % w.length;
        const typed = w.slice(0, i) + w.slice(i + 1);
        const match = matchAcceptedAnswer(typed, [w]);
        expect(match).not.toBeNull();
        expect(match!.canonical).toBe(w);
        expect(match!.distance).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('a match is accepted exactly when the distance is within the budget of the accepted word', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,12}$/), fc.stringMatching(/^[a-z ]{1,12}$/), (typed, accepted) => {
        const folded = foldAnswer(typed);
        const target = foldAnswer(accepted);
        const expectedAccept = folded !== '' && target !== '' && damerauLevenshtein(folded, target) <= maxTypoDistance(target);
        expect(matchAcceptedAnswer(typed, [accepted]) !== null).toBe(expectedAccept);
      }),
      { numRuns: 400 },
    );
  });
});
