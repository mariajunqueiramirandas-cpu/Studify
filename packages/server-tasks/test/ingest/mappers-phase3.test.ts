import { describe, expect, it } from 'vitest';
import { checkProblemConsistency, gradeAnswer, parseQuestionPayload } from '@studify/shared';
import { fadeWorkedExamples, mapFindError, mapProblem, type FindErrorDraft, type LabelMap, type ProblemDraft } from '../../src/ingest/mappers.ts';

const DOC = '0190f3a2-7b1c-7d3e-8f00-00000000d0c1';
const CONCEPT = '0190f3a2-7b1c-7d3e-8f00-0000000000c1';
const labels: LabelMap = { labels: { D1: DOC }, allowedPages: { D1: [1, 2, 3] } };
const conceptIdByKey = new Map([['c1', CONCEPT]]);
const consistent = (p: Parameters<typeof checkProblemConsistency>[0]) => checkProblemConsistency(p).ok;

const findError: FindErrorDraft = {
  statement_kind: 'solution',
  segments: [
    { id: 'S1', text: 'F = m·a' },
    { id: 'S2', text: 'F = 2·3 = 5 N' },
    { id: 'S3', text: 'Logo F = 5 N.' },
  ],
  error_segment_id: 'S2',
  error_type: 'calculo',
  explanation: '2·3 = 6.',
  corrected_text: 'F = 2·3 = 6 N',
  concept_keys: ['c1'],
  difficulty: 2,
  source_pages: [{ doc: 'D1', page_start: 2, page_end: 2 }],
};

describe('mapFindError (PRA-06.2)', () => {
  it('maps to a find_error question the shared grader accepts', () => {
    const mapped = mapFindError(findError, { labels, conceptIdByKey });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.type).toBe('find_error');
    expect(mapped.value.stem).toBe('Ache o passo errado da resolução.');
    expect(mapped.value.source_pages).toEqual([{ document_id: DOC, page_start: 2, page_end: 2 }]);
    const payload = parseQuestionPayload('find_error', mapped.value.payload);
    expect(gradeAnswer('find_error', payload, { segment_id: 'S2' }).score).toBe(1);
    expect(gradeAnswer('find_error', payload, { segment_id: 'S1' }).score).toBe(0);
  });

  it('keeps a "Não tem erro" item with a null segment', () => {
    const mapped = mapFindError({ ...findError, error_segment_id: null, error_type: null, corrected_text: null }, { labels, conceptIdByKey });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const payload = parseQuestionPayload('find_error', mapped.value.payload);
    expect(gradeAnswer('find_error', payload, { segment_id: null }).score).toBe(1);
  });

  it('drops pages that were not sent and unknown error segments', () => {
    expect(mapFindError({ ...findError, source_pages: [{ doc: 'D1', page_start: 9, page_end: 9 }] }, { labels, conceptIdByKey })).toEqual({ ok: false, reason: 'source_pages_out_of_range' });
    expect(mapFindError({ ...findError, error_segment_id: 'S7' }, { labels, conceptIdByKey })).toEqual({ ok: false, reason: 'error_segment_unknown' });
  });
});

const problem: ProblemDraft = {
  statement: 'Um corpo de 2 kg acelera a 3 m/s². Qual a força resultante?',
  given: [
    { name: 'm', value: '2' },
    { name: 'a', value: '3' },
  ],
  final_answer: '6',
  answer_format: 'numeric',
  unit: 'N',
  tolerance: 0.01,
  check_expression: 'm*a',
  solution_steps: ['F = m·a', 'F = 2·3 = 6 N'],
  hints: ['Segunda lei de Newton.', 'Multiplique massa por aceleração.', 'F = 2·3.'],
  difficulty: 2,
  concept_keys: ['c1'],
  source_pages: [{ doc: 'D1', page_start: 1, page_end: 1 }],
};

describe('mapProblem (PRA-08.2, PRA-08.6)', () => {
  it('keeps a consistent problem, graded locally', () => {
    const mapped = mapProblem(problem, { labels, conceptIdByKey, consistent });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.payload.given).toEqual({ m: 2, a: 3 });
    const payload = parseQuestionPayload('problem', mapped.value.payload);
    expect(gradeAnswer('problem', payload, { answer: '6,0' }).score).toBe(1);
  });

  it('drops a problem whose check_expression disagrees with final_answer', () => {
    expect(mapProblem({ ...problem, final_answer: '5' }, { labels, conceptIdByKey, consistent })).toEqual({ ok: false, reason: 'problem_inconsistent' });
    expect(mapProblem({ ...problem, check_expression: null }, { labels, conceptIdByKey, consistent })).toEqual({ ok: false, reason: 'problem_inconsistent' });
  });

  it('accepts an expression answer equivalent to its check expression', () => {
    const mapped = mapProblem(
      { ...problem, given: [], final_answer: '2*x + 2', answer_format: 'expression', check_expression: '2*(x+1)', tolerance: null, unit: null },
      { labels, conceptIdByKey, consistent },
    );
    expect(mapped.ok).toBe(true);
  });
});

describe('fadeWorkedExamples (PRA-08.1)', () => {
  it('hides 0, 1 and 2 final steps of examples 1–3', () => {
    const steps = ['a', 'b', 'c'];
    const faded = fadeWorkedExamples([1, 2, 3, 4].map((n) => ({ statement: `E${n}`, steps, answer: 'x' })));
    expect(faded.map((e) => e.hidden_steps)).toEqual([0, 1, 2]);
    // A two-step example never hides its first step.
    expect(fadeWorkedExamples([{ statement: 'a', steps: ['1'], answer: 'x' }, { statement: 'b', steps: ['1'], answer: 'x' }, { statement: 'c', steps: ['1', '2'], answer: 'x' }]).map((e) => e.hidden_steps)).toEqual([0, 0, 1]);
  });
});
