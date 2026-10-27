import { describe, expect, it } from 'vitest';
import {
  deriveAnswerFacts,
  hasNegativeQualifier,
  suggestMistakeCause,
  type MistakeCauseInput,
} from '../../src/practice/index.ts';
import { suggestCause } from '../../src/learning/index.ts';
import * as F from './fixtures.ts';

function input(overrides: Partial<MistakeCauseInput>): MistakeCauseInput {
  return {
    type: 'mcq_single',
    stem: F.MCQ_STEM,
    payload: F.MCQ,
    response: { choice: 'A' },
    confidence: 2,
    timeSeconds: 30,
    medianTimeSeconds: 20,
    ...overrides,
  };
}

describe('hasNegativeQualifier', () => {
  it('detects NÃO, INCORRETA(S), EXCETO and FALSA(S) written in capitals', () => {
    expect(hasNegativeQualifier('Qual alternativa NÃO descreve a função?')).toBe(true);
    expect(hasNegativeQualifier('Assinale a INCORRETA.')).toBe(true);
    expect(hasNegativeQualifier('Todas, EXCETO uma.')).toBe(true);
    expect(hasNegativeQualifier('Marque a afirmação FALSA')).toBe(true);
    expect(hasNegativeQualifier('Marque as INCORRETAS')).toBe(true);
  });

  it('ignores lowercase words and words that only contain a qualifier', () => {
    expect(hasNegativeQualifier('Isso não é verdade.')).toBe(false);
    expect(hasNegativeQualifier('A FALSAMENTE conhecida')).toBe(false);
    expect(hasNegativeQualifier(F.MCQ_STEM)).toBe(false);
  });
});

describe('suggestMistakeCause (spec 05 §8.5, first match wins)', () => {
  it('rule 1: a negative stem with a true-statement alternative picked → misread (even when fast and confident)', () => {
    const cause = suggestMistakeCause(
      input({ stem: F.MCQ_NEG_STEM, payload: F.MCQ_NEG, response: { choice: 'C' }, confidence: 4, timeSeconds: 2, medianTimeSeconds: 20 }),
    );
    expect(cause).toBe('misread');
  });

  it('rule 1 does not apply to a stem without a qualifier', () => {
    expect(suggestMistakeCause(input({ response: { choice: 'C' }, confidence: 2 }))).toBe('didnt_know');
  });

  it('rule 2: the picked alternative has a misconception concept → confused (beats careless)', () => {
    const cause = suggestMistakeCause(input({ response: { choice: 'B' }, confidence: 4, timeSeconds: 1, medianTimeSeconds: 20 }));
    expect(cause).toBe('confused');
  });

  it('rule 3: confidence 3–4 and time < 40% of the median → careless', () => {
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 3, timeSeconds: 7, medianTimeSeconds: 20 }))).toBe('careless');
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 4, timeSeconds: 7.9, medianTimeSeconds: 20 }))).toBe('careless');
  });

  it('rule 3 without a median: fast means under 15 s', () => {
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 4, timeSeconds: 14, medianTimeSeconds: null }))).toBe('careless');
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 4, timeSeconds: 15, medianTimeSeconds: null }))).toBe('didnt_know');
  });

  it('rule 4: confidence 1–2, skipped, or slow → didnt_know', () => {
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 1, timeSeconds: 1, medianTimeSeconds: 20 }))).toBe('didnt_know');
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 2, timeSeconds: 1, medianTimeSeconds: 20 }))).toBe('didnt_know');
    expect(suggestMistakeCause(input({ response: null, confidence: null, timeSeconds: 3, medianTimeSeconds: 20 }))).toBe('didnt_know');
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: 4, timeSeconds: 41, medianTimeSeconds: 20 }))).toBe('didnt_know');
  });

  it('rule 5 default: unrated, not fast, no misconception → didnt_know', () => {
    expect(suggestMistakeCause(input({ response: { choice: 'A' }, confidence: null, timeSeconds: 25, medianTimeSeconds: 20 }))).toBe('didnt_know');
  });

  it('multi_select: a picked wrong option in a negative stem → misread; a misconception-free wrong pick is not confused', () => {
    const multiInput = (choices: string[]) =>
      input({ type: 'multi_select', stem: F.MCQ_NEG_STEM, payload: F.MULTI, response: { choices }, confidence: 4, timeSeconds: 1, medianTimeSeconds: 20 });
    expect(suggestMistakeCause(multiInput(['B']))).toBe('misread');
    expect(suggestMistakeCause(multiInput(['A', 'D']))).toBe('careless');
  });

  it('true_false has no alternatives, so a negative stem does not produce misread', () => {
    const cause = suggestMistakeCause({
      type: 'true_false',
      stem: 'Assinale a afirmação FALSA',
      payload: F.TRUE_FALSE,
      response: { value: false },
      confidence: 2,
      timeSeconds: 10,
      medianTimeSeconds: 10,
    });
    expect(cause).toBe('didnt_know');
  });

  it('delegates the rule order to learning suggestCause', () => {
    const i = input({ stem: F.MCQ_NEG_STEM, payload: F.MCQ_NEG, response: { choice: 'B' }, confidence: 3, timeSeconds: 1, medianTimeSeconds: 20 });
    expect(suggestMistakeCause(i)).toBe(suggestCause(deriveAnswerFacts(i)));
  });

  it('derives the facts it reads from the payload and response', () => {
    expect(deriveAnswerFacts(input({ response: { choice: 'B' } }))).toMatchObject({
      stemHasQualifier: false,
      pickedOptionIsTrueStatement: true,
      pickedMisconceptionConceptId: 'c-nucleo',
      skipped: false,
    });
    expect(deriveAnswerFacts(input({ response: null }))).toMatchObject({ skipped: true, pickedOptionIsTrueStatement: false });
  });
});
