// GOL-08 readiness, GOL-11 predicted grade — spec 07 §8.6–8.7, learning-engine §13.
import { clamp, EPS, roundPolicy } from './util.ts';

export interface ReadinessTopic {
  id: string;
  /** ω_{e,n}: share of the test (Σ = 1). */
  weight: number;
  /** cov_n: studied (§5.1). */
  studied: boolean;
  /** m_n now (null → 0). */
  mastery: number | null;
}

export interface ReadinessResult {
  /** readiness_e ∈ [0, 1] ("se a prova fosse hoje"). */
  value: number;
  /** Σ ω · cov — the evidence gate uses ≥ 0.5. */
  coveredWeight: number;
  /** p_n = cov_n · m_n per topic. */
  perTopic: Record<string, number>;
}

/** readiness_e = Σ ω · cov · m (§13.1). Identical to spec 07 §8.6's p_n formula (L5). */
export function readiness(topics: ReadinessTopic[]): ReadinessResult {
  let value = 0;
  let coveredWeight = 0;
  const perTopic: Record<string, number> = {};
  for (const t of topics.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const cov = t.studied ? 1 : 0;
    const p = cov * (t.mastery ?? 0);
    perTopic[t.id] = p;
    value += t.weight * p;
    coveredWeight += t.weight * cov;
  }
  return { value, coveredWeight, perTopic };
}

export interface PredictionTopic {
  id: string;
  weight: number;
  studied: boolean;
  /**
   * λ_n (§5.1): 0.5 with cards and questions, 1 with cards only, 0 with questions only,
   * null with no evidence (mastery then counts as 0).
   */
  lambda: number | null;
  /** R̄_n(D_e | no further reviews): mean card retrievability at the test date. */
  retrievabilityAtExam: number | null;
  /** acc_n decayed to the test date (question accuracy). */
  accuracyAtExam: number | null;
  /** m_n now, used for the sampling uncertainty σ_sample. */
  masteryNow: number | null;
}

export interface GradeCalibration {
  /** Prior (Turma/global) fit used for shrinkage: ĝ = a + b · readiness_proj · scale. */
  prior: { a: number; b: number };
  /** Logged grades with the readiness projection at D − 1 (≥ 3 to calibrate). */
  samples: Array<{ readinessProj: number; gradeOnScale: number }>;
  /** k in θ_u = (n·θ_fit + k·θ_prior)/(n + k). */
  shrinkK?: number;
}

export interface PredictionInput {
  topics: PredictionTopic[];
  scaleMax: number;
  /** Desired retention r_target (default 0.9). */
  rTarget?: number;
  /** α: share of due reviews done on time in the last 14 days (default 0.7). */
  alpha?: number;
  /** Answered questions in scope (evidence gate ≥ 15). */
  answeredQuestionsInScope: number;
  calibration?: GradeCalibration;
}

export interface PredictedGrade {
  /** Point estimate ĝ on the school scale. */
  grade: number;
  /** 80% interval, clipped to [0, scale_max], rounded outward to the display step (0.5 on a 10-point scale). */
  lo: number;
  hi: number;
  readinessProj: number;
  sigma: number;
}

/** Least-squares fit of grade = a + b · (readiness · scale), shrunk toward the prior (§13.2, spec 07 §8.7.2). */
export function fitGradeMapping(
  samples: Array<{ x: number; y: number }>,
  prior: { a: number; b: number },
  k = 5,
): { a: number; b: number; n: number } {
  const n = samples.length;
  if (n === 0) return { a: prior.a, b: prior.b, n: 0 };
  const mx = samples.reduce((acc, s) => acc + s.x, 0) / n;
  const my = samples.reduce((acc, s) => acc + s.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    sxx += (s.x - mx) ** 2;
    sxy += (s.x - mx) * (s.y - my);
  }
  const b = sxx > EPS ? sxy / sxx : prior.b;
  const a = my - b * mx;
  return {
    a: (n * a + k * prior.a) / (n + k),
    b: (n * b + k * prior.b) / (n + k),
    n,
  };
}

/**
 * Predicted grade with an 80% interval (GOL-11, spec 07 §8.7). Returns 'not_enough' below the
 * evidence gate (covered weight < 0.5 or < 15 answered questions in scope).
 */
export function predictedGrade(input: PredictionInput): PredictedGrade | 'not_enough' {
  const S = input.scaleMax;
  const rTarget = input.rTarget ?? 0.9;
  const alpha = input.alpha ?? 0.7;
  const coveredWeight = input.topics.reduce((acc, t) => acc + (t.studied ? t.weight : 0), 0);
  if (coveredWeight < 0.5 - EPS || input.answeredQuestionsInScope < 15) return 'not_enough';

  // Projected mastery at the test date (§8.7.1): R̄^proj = α·r_target + (1 − α)·R̄(D_e | no further reviews).
  const topics = input.topics.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let readinessProj = 0;
  let sampleVar = 0;
  for (const t of topics) {
    const cov = t.studied ? 1 : 0;
    const lambda = t.lambda ?? 0;
    const rProj = alpha * rTarget + (1 - alpha) * (t.retrievabilityAtExam ?? rTarget);
    const mastery = t.lambda === null ? 0 : lambda * rProj + (1 - lambda) * (t.accuracyAtExam ?? 0);
    readinessProj += t.weight * cov * mastery;
    const pNow = cov * (t.masteryNow ?? 0);
    sampleVar += t.weight * t.weight * pNow * (1 - pNow);
  }

  // Mapping ĝ = clamp(a + b · readiness_proj · S, 0, S) (§8.7.2).
  const prior = input.calibration?.prior ?? { a: 0, b: 1 };
  const samples = input.calibration?.samples ?? [];
  let a = prior.a;
  let b = prior.b;
  // σ_model = 0.15 · S until calibrated (≥ 3 logged grades), then the residual SD of the shrunk fit.
  let sigmaModel = 0.15 * S;
  if (samples.length >= 3) {
    const fit = fitGradeMapping(
      samples.map((s) => ({ x: s.readinessProj * S, y: s.gradeOnScale })),
      prior,
      input.calibration?.shrinkK ?? 5,
    );
    a = fit.a;
    b = fit.b;
    const rss = samples.reduce((acc, s) => {
      const r = s.gradeOnScale - (a + b * s.readinessProj * S);
      return acc + r * r;
    }, 0);
    sigmaModel = Math.sqrt(rss / Math.max(1, samples.length - 2));
  }

  const grade = clamp(a + b * readinessProj * S, 0, S);
  const sigmaSample = S * Math.sqrt(sampleVar);
  const sigma = Math.sqrt(sigmaModel * sigmaModel + sigmaSample * sigmaSample);

  // Display step: 0.5 on a 10-point scale, 5 on a 100-point scale (outward rounding).
  const step = S / 20;
  const loRaw = clamp(grade - 1.28 * sigma, 0, S);
  const hiRaw = clamp(grade + 1.28 * sigma, 0, S);
  const lo = roundPolicy(loRaw, 'floor', step);
  const hi = Math.min(S, roundPolicy(hiRaw, 'ceil', step));
  return {
    grade: Math.round(grade * 100) / 100,
    lo,
    hi,
    readinessProj: Math.round(readinessProj * 10000) / 10000,
    sigma: Math.round(sigma * 1000) / 1000,
  };
}
