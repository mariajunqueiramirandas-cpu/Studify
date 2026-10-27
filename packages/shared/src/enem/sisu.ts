// Meta SISU math (spec 09 §8.4, ENM-06): the weighted SISU score, the student's current estimates and per-area
// targets that reach the reference cut-off plus a margin. Deterministic code, no AI.
import { ENEM_SCORE_AREAS, type EnemScoreArea } from './skills.ts';

export type SisuWeights = Record<EnemScoreArea, number>;
export type SisuScores = Record<EnemScoreArea, number>;

/** Realistic ceilings (configurable): 850 for the objective areas, 960 for Redação. */
export const SISU_CAPS: Readonly<SisuScores> = { LC: 850, CH: 850, CN: 850, MT: 850, RED: 960 };
export const SISU_DEFAULT_MARGIN = 15;

/** Σ w·s / Σ w. Throws when every weight is zero. */
export function sisuScore(weights: SisuWeights, scores: SisuScores): number {
  let num = 0;
  let den = 0;
  for (const k of ENEM_SCORE_AREAS) {
    num += weights[k] * scores[k];
    den += weights[k];
  }
  if (den <= 0) throw new RangeError('SISU weights sum to zero');
  return num / den;
}

export interface SimuladoEstimate {
  area: Exclude<EnemScoreArea, 'RED'>;
  score: number;
  /** ISO time the attempt was submitted. */
  at: string;
}

export interface EssayEstimate {
  total: number;
  at: string;
}

/**
 * Current estimates s_k (§8.4): mean of the last 2 simulado estimates per objective area and the mean of the last 3
 * graded essays for RED. Areas without evidence are missing from the result.
 */
export function currentEstimates(simulados: readonly SimuladoEstimate[], essays: readonly EssayEstimate[]): Partial<SisuScores> {
  const out: Partial<SisuScores> = {};
  const byNewest = <T extends { at: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const area of ['LC', 'CH', 'CN', 'MT'] as const) {
    const last = byNewest(simulados.filter((s) => s.area === area)).slice(0, 2);
    if (last.length) out[area] = last.reduce((s, x) => s + x.score, 0) / last.length;
  }
  const lastEssays = byNewest(essays).slice(0, 3);
  if (lastEssays.length) out.RED = lastEssays.reduce((s, x) => s + x.total, 0) / lastEssays.length;
  return out;
}

export interface SisuTargetInput {
  weights: SisuWeights;
  estimates: SisuScores;
  cutoff: number;
  margin?: number;
  minScores?: Partial<SisuScores>;
  caps?: Partial<SisuScores>;
}

export type SisuTargetStatus = 'above' | 'ok' | 'impossible';

export interface SisuTargetResult {
  status: SisuTargetStatus;
  /** Current weighted SISU score. */
  current: number;
  /** T = cut-off + margin. */
  required: number;
  /** Points still missing on the weighted score (0 when above). */
  gap: number;
  /** Exact targets per area. */
  targets: SisuScores;
  /** Targets rounded up: objective areas to multiples of 5, Redação to multiples of 20. */
  display: SisuScores;
}

/** Rounds up to a multiple of `step`, tolerant to floating noise (753.0000001 → 755, not 760). */
export function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step;
}

export function displayTargets(targets: SisuScores): SisuScores {
  const out = {} as SisuScores;
  for (const k of ENEM_SCORE_AREAS) out[k] = Math.min(1000, roundUpTo(targets[k], k === 'RED' ? 20 : 5));
  return out;
}

/**
 * Per-area targets (§8.4): the missing weighted points G = T·Σw − Σw·s are spread in proportion to w·h with
 * h = cap − s; a target over its cap is pinned to the cap and the rest redistributed; a target below the
 * institution minimum is pinned to the minimum and the others reduced (never below the current estimate).
 * When the caps cannot absorb G the result is `impossible` (targets stay at the caps).
 */
export function sisuTargets(input: SisuTargetInput): SisuTargetResult {
  const { weights, estimates } = input;
  const margin = input.margin ?? SISU_DEFAULT_MARGIN;
  const required = input.cutoff + margin;
  const current = sisuScore(weights, estimates);
  const cap = (k: EnemScoreArea) => Math.max(input.caps?.[k] ?? SISU_CAPS[k], input.minScores?.[k] ?? 0);
  const min = (k: EnemScoreArea) => input.minScores?.[k] ?? 0;
  const totalW = ENEM_SCORE_AREAS.reduce((s, k) => s + weights[k], 0);
  const goal = required * totalW;

  const targets = { ...estimates };
  const pinned = new Set<EnemScoreArea>();
  // Areas below their minimum must reach it whatever the cut-off.
  for (const k of ENEM_SCORE_AREAS) {
    if (estimates[k] < min(k)) {
      targets[k] = min(k);
      pinned.add(k);
    }
  }
  const weightedTotal = () => ENEM_SCORE_AREAS.reduce((s, k) => s + weights[k] * targets[k], 0);

  if (current >= required && pinned.size === 0) {
    return { status: 'above', current, required, gap: 0, targets, display: displayTargets(targets) };
  }

  let status: SisuTargetStatus = 'ok';
  for (let round = 0; round <= ENEM_SCORE_AREAS.length; round++) {
    const free = ENEM_SCORE_AREAS.filter((k) => !pinned.has(k) && weights[k] > 0);
    const fixedSum = ENEM_SCORE_AREAS.filter((k) => pinned.has(k) || weights[k] === 0).reduce((s, k) => s + weights[k] * targets[k], 0);
    const freeSum = free.reduce((s, k) => s + weights[k] * estimates[k], 0);
    const g = goal - fixedSum - freeSum;
    if (free.length === 0) {
      if (g > 1e-9) status = 'impossible';
      break;
    }
    if (g <= 0) {
      for (const k of free) targets[k] = estimates[k];
      break;
    }
    const denom = free.reduce((s, k) => s + weights[k] * (cap(k) - estimates[k]), 0);
    if (denom <= 0) {
      for (const k of free) targets[k] = Math.max(estimates[k], cap(k));
      status = 'impossible';
      break;
    }
    for (const k of free) targets[k] = estimates[k] + (g * (cap(k) - estimates[k])) / denom;
    const over = free.filter((k) => targets[k] > cap(k) + 1e-9);
    const under = free.filter((k) => targets[k] < min(k) - 1e-9);
    if (over.length === 0 && under.length === 0) break;
    for (const k of over) {
      targets[k] = cap(k);
      pinned.add(k);
    }
    for (const k of under) {
      targets[k] = min(k);
      pinned.add(k);
    }
  }
  if (status === 'ok' && weightedTotal() < goal - 1e-6) status = 'impossible';
  return { status, current, required, gap: Math.max(0, required - current), targets, display: displayTargets(targets) };
}
