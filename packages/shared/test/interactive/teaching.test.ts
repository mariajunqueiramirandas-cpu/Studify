import { describe, expect, it } from 'vitest';
import {
  applyLucasEvaluation,
  initialLucasState,
  lucasBand,
  lucasEvidence,
  lucasGaps,
  lucasOpener,
  lucasRubric,
  lucasScore,
  misconceptionsDue,
  type LucasPlan,
  type LucasTurnEvaluation,
} from '../../src/interactive/index.ts';

const pages = [{ document_id: 'doc', page_start: 3, page_end: 3 }];
const plan: LucasPlan = {
  key_concepts: [
    { id: 'k1', statement: 'A fotossíntese produz glicose.', node_id: 'n1', source_pages: pages },
    { id: 'k2', statement: 'Ocorre nos cloroplastos.', node_id: 'n2', source_pages: pages },
    { id: 'k3', statement: 'Libera oxigênio.', node_id: null, source_pages: pages },
    { id: 'k4', statement: 'Precisa de luz.', source_pages: pages },
  ],
  misconceptions: [
    { id: 'm1', lucas_belief: 'Planta come terra.', correct_concept: 'Produz o próprio alimento.', fix_criteria: ['luz', 'CO2'], trigger: 'early', source_pages: pages },
    { id: 'm2', lucas_belief: 'Só ocorre de dia.', correct_concept: 'A fase escura independe de luz.', fix_criteria: ['ciclo de Calvin'], trigger: 'mid', source_pages: pages },
    { id: 'm3', lucas_belief: 'O oxigênio vem do CO2.', correct_concept: 'Vem da água.', fix_criteria: ['fotólise'], trigger: 'late', source_pages: pages },
    { id: 'm4', lucas_belief: 'Raiz faz fotossíntese.', correct_concept: 'Folhas verdes fazem.', fix_criteria: ['clorofila'], trigger: 'mid', source_pages: pages },
  ],
  naive_questions: ['Por que a folha é verde?'],
  opener: 'E aí!',
};

const none: LucasTurnEvaluation['clarity_signals'] = { used_example: false, used_analogy: false, checked_understanding: false };
const turn = (patch: Partial<LucasTurnEvaluation>): LucasTurnEvaluation => ({
  misconception_updates: [],
  concepts_covered: [],
  errors_taught: [],
  clarity_signals: none,
  ...patch,
});

describe('Ensine o Lucas scoring (spec 12 §8.6, learning-engine §19.1)', () => {
  it('scores the rubric exactly for a fixture state', () => {
    let state = initialLucasState(plan);
    state = applyLucasEvaluation(state, turn({
      misconception_updates: [{ id: 'm1', status: 'fixed' }, { id: 'm2', status: 'partially_fixed' }, { id: 'm3', status: 'revealed' }],
      concepts_covered: [{ id: 'k1', quality: 'correct' }, { id: 'k2', quality: 'partial' }, { id: 'k3', quality: 'wrong' }],
      errors_taught: [{ claim: 'Plantas não respiram.', correction: 'Respiram.', severity: 'minor', source_pages: pages }],
      clarity_signals: { used_example: true, used_analogy: false, checked_understanding: true },
    }));
    // fixed: 40 · (1 + 0.5) / 4 = 15; coverage: 25 · (1 + 0.5) / 4 = 9.375; accuracy 20 − 5 = 15; clarity 10.
    expect(lucasRubric(state)).toEqual({ misconceptions: 15, coverage: 9.375, accuracy: 15, clarity: 10 });
    expect(lucasScore(state, 6)).toBe(49);
    expect(lucasBand(49)).toBe('almost');
  });

  it('returns too_short before turn 4', () => {
    expect(lucasScore(initialLucasState(plan), 3)).toBe('too_short');
    expect(lucasScore(initialLucasState(plan), 4)).toBe(20);
  });

  it('gives a perfect lesson 100 and floors accuracy at 0', () => {
    let state = initialLucasState(plan);
    state = applyLucasEvaluation(state, turn({
      misconception_updates: plan.misconceptions.map((m) => ({ id: m.id, status: 'fixed' as const })),
      concepts_covered: plan.key_concepts.map((c) => ({ id: c.id, quality: 'correct' as const })),
      clarity_signals: { used_example: true, used_analogy: true, checked_understanding: true },
    }));
    expect(lucasScore(state, 12)).toBe(100);
    const errors = ['a', 'b', 'c'].map((claim) => ({ claim, correction: 'x', severity: 'major' as const, source_pages: pages }));
    expect(lucasRubric(applyLucasEvaluation(state, turn({ errors_taught: errors }))).accuracy).toBe(0);
  });

  it('moves the misconception points to coverage when the plan has none (§9)', () => {
    const noMisconceptions = { ...plan, misconceptions: [] };
    let state = initialLucasState(noMisconceptions);
    state = applyLucasEvaluation(state, turn({ concepts_covered: [{ id: 'k1', quality: 'correct' }, { id: 'k2', quality: 'correct' }] }));
    expect(lucasRubric(state)).toMatchObject({ misconceptions: 0, coverage: 32.5 });
  });

  it('never moves backwards and ignores ids outside the plan', () => {
    let state = initialLucasState(plan);
    state = applyLucasEvaluation(state, turn({ misconception_updates: [{ id: 'm1', status: 'fixed' }], concepts_covered: [{ id: 'k1', quality: 'correct' }] }));
    state = applyLucasEvaluation(state, turn({
      misconception_updates: [{ id: 'm1', status: 'revealed' }, { id: 'zz', status: 'fixed' }],
      concepts_covered: [{ id: 'k1', quality: 'wrong' }, { id: 'kz', quality: 'correct' }],
    }));
    expect(state.misconceptions.m1).toBe('fixed');
    expect(state.concepts.k1).toBe('correct');
    expect(state.misconceptions.zz).toBeUndefined();
    expect(state.concepts.kz).toBeUndefined();
  });

  it('records each taught error once (normalized claim)', () => {
    const error = { claim: 'A mitocôndria faz fotossíntese.', correction: 'É o cloroplasto.', severity: 'major' as const, source_pages: pages };
    let state = applyLucasEvaluation(initialLucasState(plan), turn({ errors_taught: [error] }));
    state = applyLucasEvaluation(state, turn({ errors_taught: [{ ...error, claim: 'a mitocondria faz fotossintese' }] }));
    expect(state.errors_taught).toHaveLength(1);
  });

  it.each([
    [0, 'confused'],
    [39, 'confused'],
    [40, 'almost'],
    [69, 'almost'],
    [70, 'good'],
    [89, 'good'],
    [90, 'born_teacher'],
    [100, 'born_teacher'],
  ] as const)('band of %d is %s', (score, band) => {
    expect(lucasBand(score)).toBe(band);
  });
});

describe('Lucas results and evidence', () => {
  it('lists unfixed misconceptions and concepts that were not taught well (INT-02.7)', () => {
    const state = applyLucasEvaluation(initialLucasState(plan), turn({
      misconception_updates: [{ id: 'm1', status: 'fixed' }],
      concepts_covered: [{ id: 'k1', quality: 'correct' }, { id: 'k2', quality: 'partial' }],
    }));
    const gaps = lucasGaps(plan, state);
    expect(gaps.filter((g) => g.kind === 'misconception').map((g) => g.id)).toEqual(['m2', 'm3', 'm4']);
    expect(gaps.filter((g) => g.kind === 'concept').map((g) => g.id)).toEqual(['k2', 'k3', 'k4']);
  });

  it('emits evidence for explained concepts; a major error on a concept forces 0 (learning-engine §5.2)', () => {
    const state = applyLucasEvaluation(initialLucasState(plan), turn({
      concepts_covered: [{ id: 'k1', quality: 'correct' }, { id: 'k2', quality: 'partial' }, { id: 'k3', quality: 'correct' }],
      errors_taught: [{ claim: 'Libera CO2.', correction: 'Libera O2.', severity: 'major', source_pages: pages, concept_id: 'k3' }],
    }));
    expect(lucasEvidence(plan, state)).toEqual([
      { concept_id: 'k1', node_id: 'n1', score: 1 },
      { concept_id: 'k2', node_id: 'n2', score: 0.5 },
      { concept_id: 'k3', node_id: null, score: 0 },
    ]);
  });

  it('reveals misconceptions by trigger window (spec 12 §8.5)', () => {
    const state = initialLucasState(plan);
    expect(misconceptionsDue(plan, state, 1)).toEqual(['m1']);
    expect(misconceptionsDue(plan, state, 5)).toEqual(['m1', 'm2', 'm4']);
    expect(misconceptionsDue(plan, state, 9)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('opens with the INT-02.4 line', () => {
    expect(lucasOpener('Fotossíntese')).toBe('E aí! Faltei na aula de Fotossíntese 😅 Me explica?');
  });
});
