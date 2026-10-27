// TRI estimate for ENEM simulados (spec 09 §8.3, ENM-04.5): 3PL model, EAP with a N(0, 1) prior on an
// 81-point grid, the 500/100 reporting scale with an 80% interval, and the coherence signals (easy misses,
// lucky hits, person-fit l_z). Deterministic code, no AI.
import type { DifficultyBand, TriParamScale } from '../core/enums.ts';

export interface TriParams {
  /** Discrimination, standardized scale. */
  a: number;
  /** Difficulty, standardized scale. */
  b: number;
  /** Pseudo-guessing in [0, 1). */
  c: number;
  /** Logistic constant (1.0 default; 1.7 when the edition uses the normal-ogive scaling). */
  d?: number;
}

/** Item parameters as stored (`enem_item_params`). */
export interface StoredTriParams {
  a: number;
  b: number;
  c: number;
  scale: TriParamScale;
  logistic_d?: number;
}

export const THETA_MIN = -4;
export const THETA_MAX = 4;
export const THETA_POINTS = 81;
/** z for the 80% two-sided interval. */
export const Z80 = 1.2816;
export const EASY_MISS_P = 0.7;
export const LUCKY_HIT_P = 0.35;
export const LZ_HIGH = -1;
export const LZ_LOW = -1.64;

/** Quadrature grid θ_k, 81 points from −4 to 4. */
export const THETA_GRID: readonly number[] = Array.from({ length: THETA_POINTS }, (_, k) => THETA_MIN + (k * (THETA_MAX - THETA_MIN)) / (THETA_POINTS - 1));

const P_EPS = 1e-9;

/** P_i(θ) = c + (1 − c) / (1 + exp(−D·a·(θ − b))). */
export function pCorrect(theta: number, p: TriParams): number {
  const d = p.d ?? 1;
  return p.c + (1 - p.c) / (1 + Math.exp(-d * p.a * (theta - p.b)));
}

function clampP(p: number): number {
  return Math.min(1 - P_EPS, Math.max(P_EPS, p));
}

function median(values: readonly number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Scale of an edition's parameters (§8.1): a median `b` above 50 means the ENEM reporting scale (500/100),
 * otherwise standardized. An empty list is treated as standardized.
 */
export function detectParamScale(bs: readonly number[]): TriParamScale {
  if (bs.length === 0) return 'std';
  return median(bs) > 50 ? 'enem' : 'std';
}

/** Converts stored parameters to the standardized scale: `b_std = (b − 500)/100`, `a_std = a × 100`. */
export function toStdParams(p: StoredTriParams): TriParams {
  const d = p.logistic_d ?? 1;
  if (p.scale === 'enem') return { a: p.a * 100, b: (p.b - 500) / 100, c: p.c, d };
  return { a: p.a, b: p.b, c: p.c, d };
}

export interface ScoredResponse {
  params: TriParams;
  correct: boolean;
}

export interface EapEstimate {
  theta: number;
  se: number;
}

/** φ up to a constant (the normalization cancels in the posterior). */
function prior(theta: number): number {
  return Math.exp(-0.5 * theta * theta);
}

/**
 * EAP estimate with a standard-normal prior. Works in log space so 90-item patterns don't underflow.
 * With no responses it returns the prior mean and SD (θ 0, se ≈ 1).
 */
export function eapEstimate(responses: readonly ScoredResponse[]): EapEstimate {
  const logPost = THETA_GRID.map((theta) => {
    let ll = Math.log(prior(theta));
    for (const r of responses) {
      const p = clampP(pCorrect(theta, r.params));
      ll += r.correct ? Math.log(p) : Math.log(1 - p);
    }
    return ll;
  });
  const max = Math.max(...logPost);
  const w = logPost.map((l) => Math.exp(l - max));
  const total = w.reduce((s, x) => s + x, 0);
  let theta = 0;
  for (let k = 0; k < THETA_GRID.length; k++) theta += (w[k]! / total) * THETA_GRID[k]!;
  let variance = 0;
  for (let k = 0; k < THETA_GRID.length; k++) variance += (w[k]! / total) * (THETA_GRID[k]! - theta) ** 2;
  return { theta, se: Math.sqrt(variance) };
}

/** Reporting scale: 500 + 100·θ, rounded to the nearest point. */
export function enemScore(theta: number): number {
  return Math.round(500 + 100 * theta);
}

export type CoherenceLevel = 'alta' | 'media' | 'baixa';

export interface PersonFit {
  lz: number;
  level: CoherenceLevel;
}

/** Person-fit l_z (§8.3). Null when the variance is zero (no scorable items). */
export function personFit(responses: readonly ScoredResponse[], theta: number): PersonFit | null {
  let l0 = 0;
  let e = 0;
  let v = 0;
  for (const r of responses) {
    const p = clampP(pCorrect(theta, r.params));
    const q = 1 - p;
    l0 += r.correct ? Math.log(p) : Math.log(q);
    e += p * Math.log(p) + q * Math.log(q);
    v += p * q * Math.log(p / q) ** 2;
  }
  if (v <= 0) return null;
  const lz = (l0 - e) / Math.sqrt(v);
  return { lz, level: coherenceLevel(lz) };
}

export function coherenceLevel(lz: number): CoherenceLevel {
  if (lz >= LZ_HIGH) return 'alta';
  if (lz >= LZ_LOW) return 'media';
  return 'baixa';
}

/** One item of a simulado area, as answered. */
export interface SimuladoItemResponse {
  /** enem_items.id (or question id): echoed in the coherence lists. */
  id: string;
  /** Standardized parameters; null = no calibrated parameters (not TRI-scorable). */
  params: TriParams | null;
  annulled?: boolean;
  answerKey: string | null;
  /** Chosen letter; null = blank. */
  response: string | null;
}

export interface AreaTriResult {
  theta: number;
  se: number;
  score: number;
  ci80_low: number;
  ci80_high: number;
  /** Scorable items (non-annulled, with parameters and a key). */
  n_items: number;
  n_correct: number;
  n_blank: number;
  coherence: { lz: number | null; level: CoherenceLevel | null; easy_miss_ids: string[]; lucky_hit_ids: string[] };
}

/**
 * Scores one area (ENM-04.5): blank = incorrect (ENM-04.7), annulled items and items without parameters or key
 * are skipped. Easy misses: wrong with P(θ̂) ≥ 0.70; lucky hits: right with P(θ̂) ≤ 0.35.
 */
export function scoreArea(items: readonly SimuladoItemResponse[]): AreaTriResult {
  const scorable = items.filter((i) => !i.annulled && i.params !== null && i.answerKey !== null);
  const responses: Array<ScoredResponse & { id: string; blank: boolean }> = scorable.map((i) => ({
    id: i.id,
    params: i.params!,
    blank: i.response === null || i.response === '',
    correct: i.response !== null && i.response.toUpperCase() === i.answerKey!.toUpperCase(),
  }));
  const { theta, se } = eapEstimate(responses);
  const fit = personFit(responses, theta);
  const easy: string[] = [];
  const lucky: string[] = [];
  for (const r of responses) {
    const p = pCorrect(theta, r.params);
    if (!r.correct && p >= EASY_MISS_P) easy.push(r.id);
    if (r.correct && p <= LUCKY_HIT_P) lucky.push(r.id);
  }
  return {
    theta,
    se,
    score: enemScore(theta),
    ci80_low: Math.round(500 + 100 * (theta - Z80 * se)),
    ci80_high: Math.round(500 + 100 * (theta + Z80 * se)),
    n_items: responses.length,
    n_correct: responses.filter((r) => r.correct).length,
    n_blank: responses.filter((r) => r.blank).length,
    coherence: { lz: fit ? fit.lz : null, level: fit ? fit.level : null, easy_miss_ids: easy, lucky_hit_ids: lucky },
  };
}

/** Quartiles (Q1, Q2, Q3) by linear interpolation. Throws on an empty list. */
export function quartiles(values: readonly number[]): [number, number, number] {
  if (values.length === 0) throw new RangeError('quartiles of an empty list');
  const s = [...values].sort((x, y) => x - y);
  const at = (q: number) => {
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/** ENM-02.3 band from `b` against the area's quartiles across editions. */
export function difficultyBand(b: number, q: readonly [number, number, number]): DifficultyBand {
  if (b < q[0]) return 'facil';
  if (b < q[1]) return 'media';
  if (b < q[2]) return 'dificil';
  return 'muito_dificil';
}
