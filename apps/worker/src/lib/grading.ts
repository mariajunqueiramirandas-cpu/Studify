// Grading arithmetic for AI-graded answers (PRA-01.6, PRA-01.8). The model proposes per-criterion
// verdicts; the score is recomputed here from the stored rubric, so an answer text cannot raise its
// own grade, add criteria, or exceed a criterion's points (injection defense, security-privacy §8.1).

export interface RubricPoint {
  id: string;
  criterion: string;
  points: number;
}

export interface CriterionVerdict {
  id: string;
  verdict: 'full' | 'partial' | 'none';
  points: number;
  justification: string;
}

export type CriteriaCheck =
  | { ok: true; total: number; score: number; correct: boolean; partial: boolean }
  | { ok: false; reason: string };

const EPS = 1e-9;

/**
 * Score = Σ criterion points ÷ max points, in [0, 1]. Every verdict must name a rubric criterion,
 * appear once, and stay within that criterion's points. Otherwise the grading is rejected.
 */
export function scoreFromCriteria(rubric: readonly RubricPoint[], criteria: readonly CriterionVerdict[], maxPoints: number): CriteriaCheck {
  if (maxPoints <= 0) return { ok: false, reason: 'max_points' };
  const byId = new Map(rubric.map((r) => [r.id, r] as const));
  const seen = new Set<string>();
  let total = 0;
  for (const c of criteria) {
    const item = byId.get(c.id);
    if (!item) return { ok: false, reason: `unknown_criterion:${c.id}` };
    if (seen.has(c.id)) return { ok: false, reason: `duplicate_criterion:${c.id}` };
    seen.add(c.id);
    if (c.points < 0 || c.points > item.points + EPS) return { ok: false, reason: `points_out_of_range:${c.id}` };
    total += c.points;
  }
  const score = Math.min(1, Math.max(0, total / maxPoints));
  return { ok: true, total, score, correct: score >= 0.999, partial: score > 0 && score < 0.999 };
}

/** PRA-04.1: wrong, or partial below 0.5, creates a Caderno entry. */
export function createsMistake(score: number): boolean {
  return score < 0.5;
}

/** Rounds to 2 decimals for storage (points_awarded numeric). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
