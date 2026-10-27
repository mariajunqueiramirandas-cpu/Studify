import { describe, expect, it } from 'vitest';
import { gradeAnswer, hintCredit, isLocallyGraded } from '../../src/practice/index.ts';
import * as F from './fixtures.ts';

describe('gradeAnswer: mcq_single and true_false', () => {
  it('scores the key 1 and any other alternative 0', () => {
    expect(gradeAnswer('mcq_single', F.MCQ, { choice: 'C' })).toEqual({ correct: true, score: 1, typo: null, pending: false });
    expect(gradeAnswer('mcq_single', F.MCQ, { choice: 'B' })).toEqual({ correct: false, score: 0, typo: null, pending: false });
  });

  it('scores an unanswered question 0 without AI', () => {
    expect(gradeAnswer('mcq_single', F.MCQ, null)).toEqual({ correct: false, score: 0, typo: null, pending: false });
    expect(gradeAnswer('short_answer', F.SHORT_ANSWER, null).pending).toBe(false);
  });

  it('scores true_false by the boolean value', () => {
    expect(gradeAnswer('true_false', F.TRUE_FALSE, { value: true }).score).toBe(1);
    expect(gradeAnswer('true_false', F.TRUE_FALSE, { value: false }).score).toBe(0);
  });
});

describe('gradeAnswer: multi_select partial credit (§8.4: (TP − FP) / |correct|)', () => {
  // correct = [A, D], so |correct| = 2
  it.each([
    [['A', 'D'], 1],
    [['D', 'A'], 1],
    [['A'], 0.5],
    [['A', 'B'], 0],
    [['A', 'D', 'B'], 0.5],
    [['A', 'B', 'C'], 0],
    [[], 0],
    [['A', 'A', 'D'], 1],
  ] as const)('choices %j → %d', (choices, expected) => {
    const result = gradeAnswer('multi_select', F.MULTI, { choices: [...choices] });
    expect(result.score).toBe(expected);
    expect(result.correct).toBe(expected === 1);
  });
});

describe('gradeAnswer: fill_blank (PRA-01.7, spec 05 §11 typo acceptance)', () => {
  it('scores correct blanks / total blanks', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'ATP', '2': 'oxigênio' } })).toMatchObject({ score: 1, correct: true, typo: null });
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'ATP' } })).toMatchObject({ score: 0.5, correct: false });
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'ATP', '2': 'mitose' } })).toMatchObject({ score: 0.5, correct: false });
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: {} })).toMatchObject({ score: 0, correct: false });
  });

  it('accepts a second accepted spelling without a typo note', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'adenosina trifosfato', '2': 'oxigênio' } })).toMatchObject({
      score: 1,
      typo: null,
    });
  });

  it('accepts "mitocondria" for "mitocôndria" with the typo note (distance 0 after accent folding)', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK_TYPO, { blanks: { '1': 'mitocondria' } })).toEqual({
      correct: true,
      score: 1,
      typo: 'mitocôndria',
      pending: false,
    });
  });

  it('accepts "mitocôndira" (distance 1) for "mitocôndria" with the typo note', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK_TYPO, { blanks: { '1': 'mitocôndira' } })).toEqual({
      correct: true,
      score: 1,
      typo: 'mitocôndria',
      pending: false,
    });
  });

  it('rejects "mitose" for "mitocôndria"', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK_TYPO, { blanks: { '1': 'mitose' } })).toEqual({
      correct: false,
      score: 0,
      typo: null,
      pending: false,
    });
  });

  it('is case-insensitive and reports the canonical spelling when the case differs', () => {
    expect(gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'atp', '2': 'OXIGÊNIO' } })).toMatchObject({
      score: 1,
      typo: 'ATP, oxigênio',
    });
  });

  it('keeps the typo note only for accepted blanks', () => {
    const result = gradeAnswer('fill_blank', F.FILL_BLANK, { blanks: { '1': 'atp', '2': 'nitrogênio' } });
    expect(result.score).toBe(0.5);
    expect(result.typo).toBe('ATP');
  });
});

describe('gradeAnswer: numeric (PRA-01.7)', () => {
  it('accepts a value within tolerance with the right unit (superscript ignored)', () => {
    expect(gradeAnswer('numeric', F.NUMERIC, { number: 9.8, unit: 'm/s²' })).toMatchObject({ score: 1, correct: true });
    expect(gradeAnswer('numeric', F.NUMERIC, { number: 9.9, unit: 'm/s2' })).toMatchObject({ score: 1 });
  });

  it('rejects a value outside tolerance', () => {
    expect(gradeAnswer('numeric', F.NUMERIC, { number: 10, unit: 'm/s²' })).toMatchObject({ score: 0, correct: false });
  });

  it('treats a wrong or missing unit as wrong when the unit is required', () => {
    expect(gradeAnswer('numeric', F.NUMERIC, { number: 9.8, unit: 'km/h' })).toMatchObject({ score: 0 });
    expect(gradeAnswer('numeric', F.NUMERIC, { number: 9.8 })).toMatchObject({ score: 0 });
  });

  it('ignores the unit when it is not required; supports relative tolerance', () => {
    expect(gradeAnswer('numeric', F.NUMERIC_NO_UNIT_REQUIRED, { number: 10.05, unit: 'km' })).toMatchObject({ score: 1 });
    expect(gradeAnswer('numeric', F.NUMERIC_NO_UNIT_REQUIRED, { number: 10.2 })).toMatchObject({ score: 0 });
  });
});

describe('gradeAnswer: matching (§8.4: correct pairs / number of left items)', () => {
  it('scores 1, 2/3, 1/3 and 0 for 3 left items', () => {
    expect(gradeAnswer('matching', F.MATCHING, { pairs: [['L1', 'R2'], ['L2', 'R1'], ['L3', 'R3']] }).score).toBe(1);
    expect(gradeAnswer('matching', F.MATCHING, { pairs: [['L1', 'R2'], ['L2', 'R1'], ['L3', 'R4']] }).score).toBe(2 / 3);
    expect(gradeAnswer('matching', F.MATCHING, { pairs: [['L1', 'R2'], ['L2', 'R3'], ['L3', 'R4']] }).score).toBe(1 / 3);
    expect(gradeAnswer('matching', F.MATCHING, { pairs: [['L1', 'R1'], ['L2', 'R3'], ['L3', 'R4']] }).score).toBe(0);
  });

  it('counts a left item once, using its first pairing', () => {
    const result = gradeAnswer('matching', F.MATCHING, { pairs: [['L1', 'R2'], ['L1', 'R1'], ['L2', 'R1'], ['L3', 'R3']] });
    expect(result).toMatchObject({ score: 1, correct: true });
  });

  it('ignores pairs with unknown left items (they earn nothing)', () => {
    expect(gradeAnswer('matching', F.MATCHING, { pairs: [['L9', 'R2'], ['L2', 'R1'], ['L3', 'R3']] }).score).toBe(2 / 3);
  });
});

describe('gradeAnswer: ordering (§8.4: Kendall tau, 1 − discordant / total pairs)', () => {
  it('scores the correct order 1', () => {
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I3', 'I1', 'I2'] })).toMatchObject({ score: 1, correct: true });
  });

  it('scores one swapped adjacent pair as 2/3 (1 discordant of 3 pairs)', () => {
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I1', 'I3', 'I2'] }).score).toBe(2 / 3);
  });

  it('scores the reverse order 0', () => {
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I2', 'I1', 'I3'] }).score).toBe(0);
  });

  it('scores an order that is not a full permutation 0', () => {
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I3', 'I1'] }).score).toBe(0);
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I3', 'I3', 'I2'] }).score).toBe(0);
    expect(gradeAnswer('ordering', F.ORDERING, { order: ['I3', 'I1', 'I9'] }).score).toBe(0);
  });
});

describe('gradeAnswer: short_answer and essay_question (AI-graded, PRA-01.6)', () => {
  it('returns pending for a non-empty answer', () => {
    expect(gradeAnswer('short_answer', F.SHORT_ANSWER, { text: 'Produz ATP.' })).toEqual({
      correct: null,
      score: null,
      typo: null,
      pending: true,
    });
    expect(gradeAnswer('essay_question', F.ESSAY, { text: 'Dissertação.' }).pending).toBe(true);
  });

  it('scores an empty or whitespace-only answer 0 without AI', () => {
    expect(gradeAnswer('short_answer', F.SHORT_ANSWER, { text: '   ' })).toEqual({ correct: false, score: 0, typo: null, pending: false });
    expect(gradeAnswer('essay_question', F.ESSAY, { text: '' }).score).toBe(0);
  });
});

describe('gradeAnswer: find_error (PRA-06.4)', () => {
  it('scores the planted segment 1 and any other segment 0', () => {
    expect(gradeAnswer('find_error', F.FIND_ERROR, { segment_id: 'S1' })).toMatchObject({ score: 1, correct: true });
    expect(gradeAnswer('find_error', F.FIND_ERROR, { segment_id: 'S3' })).toMatchObject({ score: 0, correct: false });
  });

  it('is correct for "Não tem erro" only when the item has no error segment', () => {
    expect(gradeAnswer('find_error', F.FIND_ERROR_NONE, { segment_id: null })).toMatchObject({ score: 1, correct: true });
    expect(gradeAnswer('find_error', F.FIND_ERROR, { segment_id: null })).toMatchObject({ score: 0, correct: false });
    expect(gradeAnswer('find_error', F.FIND_ERROR_NONE, { segment_id: 'S1' })).toMatchObject({ score: 0 });
  });
});

describe('gradeAnswer: problem (PRA-08.3–08.4)', () => {
  it('grades numeric answers within tolerance, with PT-BR decimal comma', () => {
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4' })).toMatchObject({ score: 1, correct: true });
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4,01' })).toMatchObject({ score: 1 });
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4,5' })).toMatchObject({ score: 0 });
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: 'quatro' })).toMatchObject({ score: 0 });
  });

  it('applies hint credit: 0 hints 1.0, 1 hint 0.75, 2 hints 0.5, 3 hints 0.25', () => {
    const credit = (hintsUsed: number) => gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4' }, { hintsUsed }).score;
    expect([credit(0), credit(1), credit(2), credit(3)]).toEqual([1, 0.75, 0.5, 0.25]);
  });

  it('solving after 2 hints records 0.5 (spec 05 §11)', () => {
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4' }, { hintsUsed: 2 })).toMatchObject({ score: 0.5, correct: false });
  });

  it('viewing the solution records 0, even with a right answer (spec 05 §11)', () => {
    expect(gradeAnswer('problem', F.PROBLEM_NUMERIC, { answer: '4' }, { solutionViewed: true })).toEqual({
      correct: false,
      score: 0,
      typo: null,
      pending: false,
    });
  });

  it('grades choice answers, ignoring case and a closing parenthesis', () => {
    expect(gradeAnswer('problem', F.PROBLEM_CHOICE, { answer: 'c)' })).toMatchObject({ score: 1 });
    expect(gradeAnswer('problem', F.PROBLEM_CHOICE, { answer: 'A' })).toMatchObject({ score: 0 });
  });

  it('leaves expression answers pending (no symbolic engine on the shared path)', () => {
    expect(gradeAnswer('problem', F.PROBLEM_EXPRESSION, { answer: 'x^2+1' })).toEqual({
      correct: null,
      score: null,
      typo: null,
      pending: true,
    });
    expect(isLocallyGraded('problem', F.PROBLEM_EXPRESSION)).toBe(false);
    expect(isLocallyGraded('problem', F.PROBLEM_NUMERIC)).toBe(true);
  });
});

describe('gradeAnswer: shape and locality', () => {
  it('scores a response of the wrong shape 0 instead of throwing', () => {
    const wrong = { text: 'x' } as unknown as Parameters<typeof gradeAnswer<'mcq_single'>>[2];
    expect(gradeAnswer('mcq_single', F.MCQ, wrong)).toMatchObject({ score: 0, correct: false });
  });

  it('marks short_answer and essay_question as not locally graded', () => {
    expect(isLocallyGraded('short_answer', F.SHORT_ANSWER)).toBe(false);
    expect(isLocallyGraded('essay_question', F.ESSAY)).toBe(false);
    expect(isLocallyGraded('mcq_single', F.MCQ)).toBe(true);
  });
});

describe('hintCredit (PRA-08.3)', () => {
  it('follows the ladder for three hints and gives 0 once the solution is viewed', () => {
    expect([0, 1, 2, 3].map((h) => hintCredit(h, 3, false))).toEqual([1, 0.75, 0.5, 0.25]);
    expect(hintCredit(0, 3, true)).toBe(0);
    expect(hintCredit(1, 3, true)).toBe(0);
  });

  it('clamps hints to the ladder length', () => {
    expect(hintCredit(7, 3, false)).toBe(0.25);
    expect(hintCredit(-1, 3, false)).toBe(1);
  });
});

