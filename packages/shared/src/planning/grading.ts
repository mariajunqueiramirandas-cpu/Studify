// GOL-06 "Quanto preciso tirar?" — learning-engine §14, spec 07 §8.5.
import { z } from 'zod';
import { EPS, clean, roundPolicy } from './util.ts';

const RoundingModeSchema = z.enum(['none', 'round_half_up', 'ceil', 'floor']);
const RecoveryTypeSchema = z.enum([
  'none',
  'replace_if_higher',
  'average_with_original',
  'max_of_original_and_average',
  'replace_capped',
]);

/** `grading_rules.formula` (learning-engine §14.1). JSON field names stay snake_case because they are stored as JSON. */
export const GradingFormulaSchema = z
  .object({
    scale_max: z.number().positive(),
    grade_step: z.number().positive(),
    rounding: z.object({
      applies_to: z.array(z.enum(['term', 'year'])),
      mode: RoundingModeSchema,
      step: z.number().positive(),
    }),
    passing_average: z.number(),
    terms: z.object({
      count: z.number().int().positive(),
      label: z.string().min(1),
      weights: z.array(z.number().positive()),
    }),
    term_formula: z.enum(['weighted_average', 'points_sum']),
    recovery: z.object({
      type: RecoveryTypeSchema,
      applies_to: z.enum(['term', 'year']),
      cap: z.number().nullable(),
    }),
    final_exam: z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }),
      z.object({
        enabled: z.literal(true),
        eligible_below: z.number(),
        annual_weight: z.number().positive(),
        exam_weight: z.number().positive(),
        passing: z.number(),
      }),
    ]),
  })
  .refine((f) => f.terms.weights.length === f.terms.count, {
    message: 'terms.weights must have terms.count entries',
  });

export type GradingFormula = z.infer<typeof GradingFormulaSchema>;

export function parseGradingFormula(
  json: unknown,
): { ok: true; formula: GradingFormula } | { ok: false; issues: string[] } {
  const parsed = GradingFormulaSchema.safeParse(json);
  if (parsed.success) return { ok: true, formula: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

// ---------------------------------------------------------------- presets (spec 07 §8.5.1, open decision D-14)

export const GRADING_PRESET_IDS = [
  'media_simples_6',
  'media_simples_7',
  'pesos_2_2_3_3_media_6',
  'trimestres_media_6',
  'soma_pontos_10',
] as const;
export type GradingPresetId = (typeof GRADING_PRESET_IDS)[number];

const BASE_FORMULA: GradingFormula = {
  scale_max: 10,
  grade_step: 0.1,
  rounding: { applies_to: [], mode: 'none', step: 0.1 },
  passing_average: 6,
  terms: { count: 4, label: 'bimestre', weights: [1, 1, 1, 1] },
  term_formula: 'weighted_average',
  recovery: { type: 'replace_capped', applies_to: 'term', cap: null },
  final_exam: { enabled: false },
};

export const GRADING_PRESETS: Record<GradingPresetId, { label: string; formula: GradingFormula }> = {
  media_simples_6: { label: 'Média simples por bimestre (média 6)', formula: BASE_FORMULA },
  media_simples_7: {
    label: 'Média simples por bimestre (média 7)',
    formula: { ...BASE_FORMULA, passing_average: 7 },
  },
  pesos_2_2_3_3_media_6: {
    label: 'Pesos 2-2-3-3 (média 6)',
    formula: { ...BASE_FORMULA, terms: { count: 4, label: 'bimestre', weights: [2, 2, 3, 3] } },
  },
  trimestres_media_6: {
    label: 'Trimestres (média 6)',
    formula: { ...BASE_FORMULA, terms: { count: 3, label: 'trimestre', weights: [1, 1, 1] } },
  },
  soma_pontos_10: {
    label: 'Soma de pontos (10 pontos por bimestre)',
    formula: { ...BASE_FORMULA, term_formula: 'points_sum', recovery: { type: 'none', applies_to: 'term', cap: null } },
  },
};

/** A fresh copy of a preset formula (callers may edit it for "Personalizar"). */
export function gradingPreset(id: GradingPresetId): GradingFormula {
  return JSON.parse(JSON.stringify(GRADING_PRESETS[id].formula)) as GradingFormula;
}

// ---------------------------------------------------------------- solver types

/** One grade component of the school's rules (GOL-06.2). `termIndex` is 1-based (1º bimestre = 1). */
export interface GradeComponent {
  id: string;
  termIndex: number;
  /** Weight inside the term (weighted_average). */
  weight?: number | null;
  /** Points available (points_sum). */
  maxPoints?: number | null;
  /** Logged result, or null while pending. Scale grade for weighted_average; points for points_sum. */
  grade?: number | null;
}

/** What the student wants: the passing average (default) or a custom goal, at term or year level. */
export type GradeTarget = { level: 'term'; termIndex: number; value?: number } | { level: 'year'; value?: number };

export type RequiredGradeResult =
  | {
      kind: 'incomplete';
      reason: 'no_components' | 'missing_weights' | 'missing_max_points' | 'invalid_grade' | 'invalid_target';
    }
  | { kind: 'secured' }
  | {
      /** `value` is the grade every pending component must reach (weighted), or the total pending points (points_sum). */
      kind: 'required';
      value: number;
      pendingIds: string[];
      /** points_sum only: uniform percentage of every pending component, and points per component. */
      percent?: number;
      points?: Array<{ id: string; points: number }>;
    }
  | {
      kind: 'impossible';
      /** Recuperação grade needed under the recovery policy (undefined when the policy cannot reach the target). */
      recovery?: number;
      /** Final-exam grade needed (year targets with final_exam enabled). */
      finalExam?: number;
    };

interface Slot {
  id: string;
  termIndex: number;
  weight: number;
  maxPoints: number;
  logged: number | null;
}

function recover(g: number, r: number, type: GradingFormula['recovery']['type'], cap: number | null, passing: number): number {
  switch (type) {
    case 'replace_if_higher':
      return Math.max(g, r);
    case 'average_with_original':
      return (g + r) / 2;
    case 'max_of_original_and_average':
      return Math.max(g, (g + r) / 2);
    // Spec form is min(cap, max(g, r)); that would lower a grade already above the cap, so the
    // cap only limits the recovered grade. Identical whenever the recovery applies to a failing term.
    case 'replace_capped':
      return Math.max(g, Math.min(cap ?? passing, r));
    default:
      return g;
  }
}

/**
 * Required grade for the pending components in scope (learning-engine §14.2, spec 07 §8.5.2).
 * Every pending component in scope gets the same value (GOL-06.5). f(x) is monotone
 * non-decreasing for every supported policy, so a binary search over the grade_step grid is exact.
 */
export function requiredGrade(
  rules: GradingFormula,
  comps: GradeComponent[],
  target: GradeTarget,
): RequiredGradeResult {
  const S = rules.scale_max;
  const step = rules.grade_step;
  const isPoints = rules.term_formula === 'points_sum';
  const goal = target.value ?? rules.passing_average;
  if (!Number.isFinite(goal)) return { kind: 'incomplete', reason: 'invalid_target' };
  if (target.level === 'term' && (target.termIndex < 1 || target.termIndex > rules.terms.count)) {
    return { kind: 'incomplete', reason: 'invalid_target' };
  }
  const terms: number[] = [];
  if (target.level === 'term') terms.push(target.termIndex);
  else for (let t = 1; t <= rules.terms.count; t++) terms.push(t);

  // Build slots: one per component, or a virtual pending slot for a term with no components yet (B4 in example B).
  const slots: Slot[] = [];
  for (const t of terms) {
    const inTerm = comps
      .filter((c) => c.termIndex === t)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (inTerm.length === 0) {
      if (isPoints) return { kind: 'incomplete', reason: 'no_components' };
      slots.push({ id: `term:${t}`, termIndex: t, weight: 1, maxPoints: 0, logged: null });
      continue;
    }
    for (const c of inTerm) {
      if (isPoints) {
        if (c.maxPoints == null || !(c.maxPoints > 0)) return { kind: 'incomplete', reason: 'missing_max_points' };
        if (c.grade != null && (c.grade < 0 || c.grade > c.maxPoints)) return { kind: 'incomplete', reason: 'invalid_grade' };
        slots.push({ id: c.id, termIndex: t, weight: 0, maxPoints: c.maxPoints, logged: c.grade ?? null });
      } else {
        if (c.weight == null || !(c.weight > 0)) return { kind: 'incomplete', reason: 'missing_weights' };
        if (c.grade != null && (c.grade < 0 || c.grade > S)) return { kind: 'incomplete', reason: 'invalid_grade' };
        slots.push({ id: c.id, termIndex: t, weight: c.weight, maxPoints: 0, logged: c.grade ?? null });
      }
    }
  }

  const pending = slots.filter((s) => s.logged == null);
  const poolMax = pending.reduce((a, s) => a + s.maxPoints, 0);
  const top = isPoints ? poolMax : S;
  const rounding = rules.rounding;
  const roundTerm = rounding.applies_to.includes('term');
  const roundYear = rounding.applies_to.includes('year');
  const rec = rules.recovery;

  // `p` is the uniform grade (weighted) or the total pending points (points_sum, same percentage on every component).
  const fillOf = (p: number) => (s: Slot): number => {
    if (!isPoints) return p;
    return poolMax > 0 ? (p * s.maxPoints) / poolMax : 0;
  };

  const termGrade = (t: number, fill: (s: Slot) => number): number => {
    const ts = slots.filter((s) => s.termIndex === t);
    let value: number;
    if (isPoints) {
      let pts = 0;
      let maxSum = 0;
      for (const s of ts) {
        pts += s.logged ?? fill(s);
        maxSum += s.maxPoints;
      }
      // points_sum scales to scale_max when the components do not add up to it (learning-engine §14.1).
      const factor = Math.abs(maxSum - S) > EPS && maxSum > 0 ? S / maxSum : 1;
      value = pts * factor;
    } else {
      let sw = 0;
      let sum = 0;
      for (const s of ts) {
        sw += s.weight;
        sum += s.weight * (s.logged ?? fill(s));
      }
      value = sw > 0 ? sum / sw : 0;
    }
    return roundPolicy(value, roundTerm ? rounding.mode : 'none', rounding.step);
  };

  const evaluate = (p: number, r?: number): number => {
    const fill = fillOf(p);
    const useRec = r !== undefined && rec.type !== 'none';
    const grades = new Map<number, number>();
    for (const t of terms) grades.set(t, termGrade(t, fill));
    if (target.level === 'term') {
      const g = grades.get(target.termIndex) ?? 0;
      return useRec && rec.applies_to === 'term' ? recover(g, r, rec.type, rec.cap, rules.passing_average) : g;
    }
    if (useRec && rec.applies_to === 'term') {
      for (const t of terms) {
        const g = grades.get(t) ?? 0;
        if (g < rules.passing_average) grades.set(t, recover(g, r, rec.type, rec.cap, rules.passing_average));
      }
    }
    let sw = 0;
    let sum = 0;
    for (const t of terms) {
      const w = rules.terms.weights[t - 1] ?? 1;
      sw += w;
      sum += w * (grades.get(t) ?? 0);
    }
    let year = sw > 0 ? sum / sw : 0;
    year = roundPolicy(year, roundYear ? rounding.mode : 'none', rounding.step);
    if (useRec && rec.applies_to === 'year') year = recover(year, r, rec.type, rec.cap, rules.passing_average);
    return year;
  };

  const f0 = evaluate(0);
  if (f0 >= goal - EPS) return { kind: 'secured' };

  const fTop = evaluate(top);
  if (fTop < goal - EPS) {
    const out: RequiredGradeResult = { kind: 'impossible' };
    const recovery = solveRecovery(evaluate, top, goal, S, step);
    if (rec.type !== 'none' && recovery !== undefined) out.recovery = recovery;
    if (target.level === 'year' && rules.final_exam.enabled) {
      const fe = rules.final_exam;
      const yearAtTop = evaluate(top);
      if (yearAtTop < fe.eligible_below - EPS) {
        const needed =
          (fe.passing * (fe.annual_weight + fe.exam_weight) - yearAtTop * fe.annual_weight) / fe.exam_weight;
        const finalExam = clean(Math.ceil(Math.max(0, needed) / step - EPS) * step);
        if (finalExam <= S + EPS) out.finalExam = finalExam;
      }
    }
    return out;
  }

  // Binary search on the grid k·grade_step (points_sum: k·grade_step pending points), capped at `top`.
  const gridVal = (k: number): number => Math.min(clean(k * step), top);
  const K = Math.ceil(top / step - EPS);
  let lo = 1;
  let hi = Math.max(1, K);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (evaluate(gridVal(mid)) >= goal - EPS) hi = mid;
    else lo = mid + 1;
  }
  const value = gridVal(lo);
  const pendingIds = pending.map((s) => s.id);
  if (!isPoints) return { kind: 'required', value, pendingIds };
  return {
    kind: 'required',
    value,
    pendingIds,
    percent: Math.round((value / poolMax) * 100),
    points: pending.map((s) => ({ id: s.id, points: clean((value * s.maxPoints) / poolMax) })),
  };
}

function solveRecovery(
  evaluate: (p: number, r?: number) => number,
  top: number,
  goal: number,
  S: number,
  step: number,
): number | undefined {
  const ok = (r: number) => evaluate(top, r) >= goal - EPS;
  const gridVal = (k: number): number => Math.min(clean(k * step), S);
  const K = Math.ceil(S / step - EPS);
  if (!ok(gridVal(K))) return undefined;
  let lo = 0;
  let hi = K;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(gridVal(mid))) hi = mid;
    else lo = mid + 1;
  }
  return gridVal(lo);
}

/** Decimal-comma display ("5,4"). Decimals follow the grade step (0.1 → 1, 0.25 → 2, 1 → 0). */
export function formatGradeBr(value: number, gradeStep = 0.1): string {
  const decimals = (gradeStep.toString().split('.')[1] ?? '').length;
  return value.toFixed(decimals).replace('.', ',');
}
