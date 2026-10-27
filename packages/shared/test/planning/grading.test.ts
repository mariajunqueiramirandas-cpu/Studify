import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  GRADING_PRESET_IDS,
  GRADING_PRESETS,
  GradingFormulaSchema,
  formatGradeBr,
  gradingPreset,
  parseGradingFormula,
  requiredGrade,
  type GradeComponent,
  type GradeTarget,
  type GradingFormula,
  type RequiredGradeResult,
} from '../../src/planning/index.ts';

// Hand-computed fixtures from learning-engine §14.3 and spec 07 §8.5.3 (A–H).
// Rules default to four bimesters with equal weights and passing average 6.

const rules = (over: Partial<GradingFormula> = {}): GradingFormula => ({
  ...gradingPreset('media_simples_6'),
  ...over,
});

const c = (id: string, termIndex: number, weight: number, grade: number | null): GradeComponent => ({
  id,
  termIndex,
  weight,
  grade,
});

const pts = (id: string, termIndex: number, maxPoints: number, grade: number | null): GradeComponent => ({
  id,
  termIndex,
  maxPoints,
  grade,
});

const term1: GradeTarget = { level: 'term', termIndex: 1 };

function expectRequired(result: RequiredGradeResult, value: number): void {
  expect(result.kind).toBe('required');
  if (result.kind !== 'required') return;
  expect(result.value).toBeCloseTo(value, 9);
}

describe('GOL-06 grade fixtures (learning-engine §14.3 / spec 07 §8.5.3)', () => {
  it('A: term 0,4·P1 + 0,4·P2 + 0,2·Trab, P1 5,0, Trab 8,0 → need 6,0 on P2', () => {
    const comps = [c('P1', 1, 0.4, 5), c('P2', 1, 0.4, null), c('Trab', 1, 0.2, 8)];
    const r = requiredGrade(rules(), comps, term1);
    expectRequired(r, 6.0);
    expect(r.kind === 'required' && r.pendingIds).toEqual(['P2']);
    expect(formatGradeBr(6, 0.1)).toBe('6,0');
  });

  it('B: year weights 2-2-3-3 → B4 ≥ 5,4; nested B4 (P1 4,0, Trab 9,0) → P2 5,0', () => {
    const r4 = rules({ terms: { count: 4, label: 'bimestre', weights: [2, 2, 3, 3] } });
    const year = [c('B1', 1, 1, 5.5), c('B2', 2, 1, 6.0), c('B3', 3, 1, 7.0)];
    expectRequired(requiredGrade(r4, year, { level: 'year' }), 5.4);
    expect(formatGradeBr(5.4)).toBe('5,4');

    const nested = [c('P1', 4, 0.4, 4), c('P2', 4, 0.4, null), c('Trab', 4, 0.2, 9)];
    expectRequired(requiredGrade(r4, nested, { level: 'term', termIndex: 4, value: 5.4 }), 5.0);
  });

  it('C: recuperação average_with_original, term 4,0, target 6,0 → recuperação 8,0; replace_capped → 6,0', () => {
    const comps = [c('T1', 1, 1, 4.0)];
    const avg = rules({ recovery: { type: 'average_with_original', applies_to: 'term', cap: null } });
    const r1 = requiredGrade(avg, comps, term1);
    expect(r1).toEqual({ kind: 'impossible', recovery: 8 });

    const capped = rules({ recovery: { type: 'replace_capped', applies_to: 'term', cap: 6 } });
    expect(requiredGrade(capped, comps, term1)).toEqual({ kind: 'impossible', recovery: 6 });
  });

  it('D: year average 4,0 with final 6/4 and passing 5,0 → final exam 6,5', () => {
    const r = rules({
      terms: { count: 1, label: 'ano', weights: [1] },
      recovery: { type: 'none', applies_to: 'term', cap: null },
      final_exam: { enabled: true, eligible_below: 6, annual_weight: 6, exam_weight: 4, passing: 5 },
    });
    const comps = [c('Y', 1, 1, 4.0)];
    expect(requiredGrade(r, comps, { level: 'year' })).toEqual({ kind: 'impossible', finalExam: 6.5 });
  });

  it('E: points — Prova 6 + Trab 2 + Lista 2, passing 6 pts, Trab 1,5 and Lista 2,0 → Prova 2,5 (42%)', () => {
    const r = rules({
      term_formula: 'points_sum',
      terms: { count: 1, label: 'bimestre', weights: [1] },
      recovery: { type: 'none', applies_to: 'term', cap: null },
    });
    const comps = [pts('Prova', 1, 6, null), pts('Trab', 1, 2, 1.5), pts('Lista', 1, 2, 2.0)];
    const res = requiredGrade(r, comps, term1);
    expect(res.kind).toBe('required');
    if (res.kind !== 'required') return;
    expect(res.value).toBe(2.5);
    expect(res.percent).toBe(42);
    expect(res.points).toEqual([{ id: 'Prova', points: 2.5 }]);
    expect(formatGradeBr(res.value)).toBe('2,5');
  });

  it('F: as A with P1 also pending → 5,5 on each pending component', () => {
    const comps = [c('P1', 1, 0.4, null), c('P2', 1, 0.4, null), c('Trab', 1, 0.2, 8)];
    const r = requiredGrade(rules(), comps, term1);
    expectRequired(r, 5.5);
    expect(r.kind === 'required' && r.pendingIds).toEqual(['P1', 'P2']);
  });

  it('G: as A with term rounding half-up step 0,5 → 5,4', () => {
    const r = rules({ rounding: { applies_to: ['term'], mode: 'round_half_up', step: 0.5 } });
    const comps = [c('P1', 1, 0.4, 5), c('P2', 1, 0.4, null), c('Trab', 1, 0.2, 8)];
    expectRequired(requiredGrade(r, comps, term1), 5.4);
  });

  it('H: P1 10, Trab 10 → already secured; P1 9 needs 1,0', () => {
    const secured = [c('P1', 1, 0.4, 10), c('P2', 1, 0.4, null), c('Trab', 1, 0.2, 10)];
    expect(requiredGrade(rules(), secured, term1)).toEqual({ kind: 'secured' });

    const notYet = [c('P1', 1, 0.4, 9), c('P2', 1, 0.4, null), c('Trab', 1, 0.2, 10)];
    expectRequired(requiredGrade(rules(), notYet, term1), 1.0);
  });
});

describe('GOL-06 edge cases', () => {
  it('a term with no logged components still counts as pending (virtual slot)', () => {
    const r = rules({ terms: { count: 2, label: 'bimestre', weights: [1, 1] } });
    // Year target, term 1 logged at 6,0, term 2 has no components: 6,0 needed (average of 6,0 and x ≥ 6).
    expectRequired(requiredGrade(r, [c('A', 1, 1, 6)], { level: 'year' }), 6);
  });

  it('missing weights and invalid grades are reported, not guessed', () => {
    expect(requiredGrade(rules(), [c('P1', 1, null as unknown as number, 5)], term1)).toEqual({
      kind: 'incomplete',
      reason: 'missing_weights',
    });
    expect(requiredGrade(rules(), [c('P1', 1, 1, 11)], term1)).toEqual({ kind: 'incomplete', reason: 'invalid_grade' });
  });

  it('a points_sum term without components is incomplete', () => {
    const r = rules({ term_formula: 'points_sum' });
    expect(requiredGrade(r, [], term1)).toEqual({ kind: 'incomplete', reason: 'no_components' });
  });

  it('the grid is 0.1 for 0–10 and the impossible branch shows the recovery hint', () => {
    const r = rules({ recovery: { type: 'replace_if_higher', applies_to: 'term', cap: null } });
    const comps = [c('P1', 1, 1, 3.0), c('P2', 1, 1, null)];
    // Term = (3 + x)/2 ≥ 6 needs x = 9 → required, not impossible.
    expectRequired(requiredGrade(r, comps, term1), 9);
    const hopeless = [c('P1', 1, 1, 3.0), c('P2', 1, 1, 3.0)];
    expect(requiredGrade(r, hopeless, term1)).toEqual({ kind: 'impossible', recovery: 6 });
  });

  it('a 0–100 scale works with the same solver', () => {
    const r = rules({ scale_max: 100, grade_step: 1, passing_average: 60 });
    const comps = [c('P1', 1, 0.5, 50), c('P2', 1, 0.5, null)];
    expectRequired(requiredGrade(r, comps, term1), 70);
  });
});

describe('presets (D-14)', () => {
  it('every preset validates against the formula schema', () => {
    for (const id of GRADING_PRESET_IDS) {
      const parsed = parseGradingFormula(GRADING_PRESETS[id].formula);
      expect(parsed.ok, id).toBe(true);
    }
  });

  it('the 2-2-3-3 preset has those weights and the soma de pontos preset is points_sum', () => {
    expect(gradingPreset('pesos_2_2_3_3_media_6').terms.weights).toEqual([2, 2, 3, 3]);
    expect(gradingPreset('soma_pontos_10').term_formula).toBe('points_sum');
    expect(GRADING_PRESETS.trimestres_media_6.formula.terms.count).toBe(3);
  });

  it('rejects a formula whose weights do not match the term count', () => {
    const bad = { ...gradingPreset('media_simples_6'), terms: { count: 4, label: 'bimestre', weights: [1, 1] } };
    expect(GradingFormulaSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------- properties

const weightedRules = fc
  .record({
    count: fc.integer({ min: 1, max: 3 }),
    weights: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
    rounding: fc.constantFrom('none', 'round_half_up', 'ceil', 'floor') as fc.Arbitrary<'none' | 'round_half_up' | 'ceil' | 'floor'>,
    roundStep: fc.constantFrom(0.1, 0.5, 1),
    passing: fc.integer({ min: 4, max: 8 }),
  })
  .map(({ count, weights, rounding, roundStep, passing }) =>
    rules({
      passing_average: passing,
      terms: { count, label: 'bimestre', weights: weights.slice(0, count) },
      rounding: { applies_to: ['term', 'year'], mode: rounding, step: roundStep },
      recovery: { type: 'none', applies_to: 'term', cap: null },
    }),
  );

const halfSteps = fc.integer({ min: 0, max: 20 }).map((n) => n / 2);

// One component per term at least, so every term has a caller-visible slot to fill.
const compsFor = (count: number): fc.Arbitrary<GradeComponent[]> =>
  fc
    .array(
      fc.record({
        term: fc.integer({ min: 1, max: count }),
        weight: fc.integer({ min: 1, max: 5 }),
        grade: fc.option(halfSteps, { nil: null }),
      }),
      { minLength: 0, maxLength: 5 },
    )
    .map((list) => {
      const base = Array.from({ length: count }, (_, i) => ({ term: i + 1, weight: 1, grade: null as number | null }));
      return [...base, ...list].map((x, i) => ({ id: `c${i}`, termIndex: x.term, weight: x.weight, grade: x.grade }));
    });

const scenario = fc
  .integer({ min: 1, max: 3 })
  .chain((count) =>
    fc.record({
      rules: weightedRules.map((r) => ({ ...r, terms: { ...r.terms, count, weights: r.terms.weights.slice(0, count).concat(Array(Math.max(0, count - r.terms.weights.length)).fill(1)) } })),
      comps: compsFor(count),
      target: halfSteps.map((v) => v),
    }),
  );

describe('properties', () => {
  it('monotone in the target: a higher goal never needs a lower grade', () => {
    fc.assert(
      fc.property(scenario, halfSteps, (s, extra) => {
        // Ensure a pending component exists in the scope so the target can matter.
        const comps = s.comps.map((x) => ({ ...x }));
        if (comps.every((x) => x.grade != null)) comps[0] = { ...comps[0]!, grade: null };
        const low = 4 + (s.target % 3);
        const high = low + extra / 2 + 0.5;
        const target: GradeTarget = { level: 'year', value: low };
        const a = requiredGrade(s.rules as GradingFormula, comps, target);
        const b = requiredGrade(s.rules as GradingFormula, comps, { level: 'year', value: high });
        if (a.kind === 'required' && b.kind === 'required') {
          expect(a.value).toBeLessThanOrEqual(b.value + 1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('plugging the required grade back reaches the target, and one grid step less does not', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const comps = s.comps.map((x) => ({ ...x }));
        if (comps.every((x) => x.grade != null)) comps[0] = { ...comps[0]!, grade: null };
        const goal = 4 + (s.target % 5);
        const target: GradeTarget = { level: 'year', value: goal };
        const rulesWithStep = s.rules as GradingFormula;
        const result = requiredGrade(rulesWithStep, comps, target);
        if (result.kind !== 'required') return;
        const pendingIds = new Set(result.pendingIds);
        const fill = (v: number) =>
          comps.map((x) => (pendingIds.has(x.id) ? { ...x, grade: v } : x));
        // Filled with the answer, nothing is pending: secured means the target is reached.
        expect(requiredGrade(rulesWithStep, fill(result.value), target).kind).toBe('secured');
        const lower = Math.round((result.value - rulesWithStep.grade_step) * 1e9) / 1e9;
        if (lower >= 0) {
          expect(requiredGrade(rulesWithStep, fill(lower), target).kind).not.toBe('secured');
        }
      }),
      { numRuns: 300 },
    );
  });
});
