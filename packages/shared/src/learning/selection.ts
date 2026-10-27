// Question selection (learning-engine §6; spec 05 §8.3, §8.7, §8.10, spec 03 §8.4, spec 10 §8.2).
import { MASTERY_DEFAULTS, SELECTION } from './params.ts';
import { daysUntil } from './time.ts';
import type { EvidenceQuestionType, ExamScope, LearningParams } from './types.ts';
import { largestRemainder, mean, round1, sigmoid, clamp, compareStrings } from './util.ts';
import { seededRandom, seededShuffle, weightedSampleWithoutReplacement } from './rng.ts';

// ---------- predicted success (§6.1) ----------

export interface PredictionModel {
  alpha: number;
  beta0: number;
}

export const DEFAULT_PREDICTION_MODEL: Readonly<PredictionModel> = Object.freeze({
  alpha: SELECTION.alpha,
  beta0: SELECTION.beta0,
});

/** δ_q = (difficulty − 3) / 2, mapping difficulty 1–5 to [−1, 1]. */
export function difficultyDelta(difficulty: number): number {
  return (difficulty - 3) / 2;
}

/**
 * p̂ = σ(β₀ + α·((2m − 1) − δ_q)) (§6.1). `conceptMasteries` holds one mastery per concept of the
 * question (null → 0.5); multi-concept questions average over their concepts.
 */
export function predictSuccess(input: {
  difficulty: number;
  conceptMasteries: ReadonlyArray<number | null>;
  model?: PredictionModel;
}): number {
  const model = input.model ?? DEFAULT_PREDICTION_MODEL;
  const m = mean(input.conceptMasteries.map((x) => x ?? 0.5)) ?? 0.5;
  const x = 2 * m - 1 - difficultyDelta(input.difficulty);
  return sigmoid(model.beta0 + model.alpha * x);
}

export interface PredictionObservation {
  difficulty: number;
  /** Mastery of the concept at the time of the first attempt (null → 0.5). */
  mastery: number | null;
  correct: boolean;
}

/**
 * Per-subject refit of (α, β₀) by logistic regression on first attempts (§6.1). Needs
 * `refitMinAttempts` observations; otherwise returns the prior unchanged. The fit is shrunk toward
 * the prior with weight 50: θ = (n·θ_fit + 50·θ_prior) / (n + 50).
 */
export function refitPredictionModel(
  observations: readonly PredictionObservation[],
  prior: PredictionModel = DEFAULT_PREDICTION_MODEL,
): { model: PredictionModel; n: number; refitted: boolean } {
  const n = observations.length;
  if (n < SELECTION.refitMinAttempts) return { model: { ...prior }, n, refitted: false };

  // Features: x = (2m − 1) − δ, with intercept. Parameters θ = (β₀, α).
  const xs = observations.map((o) => 2 * (o.mastery ?? 0.5) - 1 - difficultyDelta(o.difficulty));
  const ys = observations.map((o) => (o.correct ? 1 : 0));
  let beta0 = prior.beta0;
  let alpha = prior.alpha;

  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 1e-9;
    let h01 = 0;
    let h11 = 1e-9;
    for (let i = 0; i < n; i++) {
      const x = xs[i] ?? 0;
      const p = sigmoid(beta0 + alpha * x);
      const err = (ys[i] ?? 0) - p;
      const wgt = p * (1 - p);
      g0 += err;
      g1 += err * x;
      h00 += wgt;
      h01 += wgt * x;
      h11 += wgt * x * x;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    // Newton step: θ += H⁻¹ g
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (-h01 * g0 + h00 * g1) / det;
    beta0 += clamp(d0, -2, 2);
    alpha += clamp(d1, -2, 2);
    if (Math.abs(d0) < 1e-9 && Math.abs(d1) < 1e-9) break;
  }

  const w = SELECTION.refitShrink;
  return {
    model: {
      beta0: (n * beta0 + w * prior.beta0) / (n + w),
      alpha: (n * alpha + w * prior.alpha) / (n + w),
    },
    n,
    refitted: true,
  };
}

// ---------- exam urgency (§6.2) ----------

/**
 * examUrgency(c) = weight_norm(E) × exp(−days_until(E) / 7) for the earliest scheduled exam E
 * (not yet started) whose scope contains the concept. 0 when none. Unlike the review queue's
 * step function (L7), this decays smoothly and is used by the Feed and adaptive selection.
 */
export function examUrgency(conceptId: string, exams: readonly ExamScope[], now: Date, params: LearningParams): number {
  const upcoming = exams
    .filter((e) => e.status === 'scheduled' && e.startsAt.getTime() > now.getTime() && e.nodeIds.includes(conceptId))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || compareStrings(a.examId, b.examId));
  const earliest = upcoming[0];
  if (!earliest) return 0;
  const days = daysUntil(earliest.startsAt, now, params.timeZone);
  return earliest.weightNorm * Math.exp(-days / 7);
}

// ---------- adaptive quiz selection (§6.3) ----------

export interface QuizCandidate {
  questionId: string;
  conceptId: string;
  questionType: EvidenceQuestionType;
  /** p̂ from predictSuccess. */
  pHat: number;
  seenBefore: boolean;
  /** Days since this question was last answered correctly (null = never). */
  daysSinceCorrect: number | null;
  /** The concept is overconfident (§8). */
  overconfident: boolean;
  examUrgency: number;
  /** Caderno retry due today: goes first in "Pontos fracos" and "Hoje" quizzes (§6.3). */
  cadernoRetryDue?: boolean;
}

/** score(q) = 1 − |p̂ − 0.72| + 0.3·[unseen] + 0.2·[overconfident] + 0.3·examUrgency (§6.3). */
export function adaptiveScore(c: QuizCandidate): number {
  return (
    1 -
    Math.abs(c.pHat - SELECTION.targetSuccess) +
    (c.seenBefore ? 0 : SELECTION.unseenBonus) +
    (c.overconfident ? SELECTION.overconfidentBonus : 0) +
    SELECTION.examUrgencyWeight * c.examUrgency
  );
}

/**
 * Greedy adaptive pick (§6.3): candidates answered correctly in the last 7 days are excluded; Caderno
 * retries due come first; at most 2 questions per concept; at least 3 question types when available
 * (the best candidate of each new type is taken before the greedy fill).
 */
export function selectAdaptiveQuiz(candidates: readonly QuizCandidate[], count: number): string[] {
  const eligible = candidates
    .filter((c) => c.daysSinceCorrect === null || c.daysSinceCorrect >= SELECTION.recentCorrectDays)
    .sort((a, b) => {
      const retry = Number(b.cadernoRetryDue === true) - Number(a.cadernoRetryDue === true);
      return retry || adaptiveScore(b) - adaptiveScore(a) || compareStrings(a.questionId, b.questionId);
    });

  const selected: QuizCandidate[] = [];
  const picked = new Set<string>();
  const perConcept = new Map<string, number>();
  const types = new Set<EvidenceQuestionType>();
  const canTake = (c: QuizCandidate): boolean => (perConcept.get(c.conceptId) ?? 0) < SELECTION.maxPerConcept;
  const take = (c: QuizCandidate): void => {
    selected.push(c);
    picked.add(c.questionId);
    perConcept.set(c.conceptId, (perConcept.get(c.conceptId) ?? 0) + 1);
    types.add(c.questionType);
  };

  for (const c of eligible) {
    if (selected.length >= count) break;
    if (c.cadernoRetryDue && canTake(c)) take(c);
  }
  for (const c of eligible) {
    if (selected.length >= count || types.size >= SELECTION.minTypes) break;
    if (!picked.has(c.questionId) && !types.has(c.questionType) && canTake(c)) take(c);
  }
  for (const c of eligible) {
    if (selected.length >= count) break;
    if (!picked.has(c.questionId) && canTake(c)) take(c);
  }
  return selected.map((c) => c.questionId);
}

// ---------- simulado composition (§6.4) ----------

export interface SimuladoCandidate {
  questionId: string;
  topicId: string;
  /** Difficulty 1–5 (empirical band when available, §6.5). */
  difficulty: number;
  /** Days since last seen (null = never seen). */
  daysSinceSeen: number | null;
}

export interface SimuladoInput {
  count: number;
  /** Topics in knowledge-map order with their weights (Prova Provável ω, or page counts). */
  topics: ReadonlyArray<{ topicId: string; weight: number }>;
  candidates: readonly SimuladoCandidate[];
  /** `${userId}|${quizId}`: the seed for every sampling step. */
  seed: string;
  order?: 'grouped' | 'interleaved';
}

export interface SimuladoResult {
  questionIds: string[];
  perTopic: Record<string, number>;
  /** Questions that could not be found; generate more before the start (§6.4 step 4). */
  shortfall: number;
}

const SIMULADO_BUCKET_SHARES = [0.2, 0.6, 0.2] as const;

function bucketOf(difficulty: number): number {
  if (difficulty <= 2) return 0;
  if (difficulty === 3) return 1;
  return 2;
}

/**
 * Simulado composition (§6.4): topic allocation by largest remainder (each topic gets ≥ 1 when
 * count ≥ #topics), difficulty spread 20/60/20, unseen first and nothing seen in the last 7 days
 * unless the bank is short, then the oldest-seen. Deterministic for a given seed.
 */
export function composeSimulado(input: SimuladoInput): SimuladoResult {
  const topics = input.topics;
  const T = topics.length;
  if (T === 0 || input.count <= 0) return { questionIds: [], perTopic: {}, shortfall: Math.max(0, input.count) };

  const weights = topics.map((t) => Math.max(0, t.weight));
  let quotas: number[];
  if (input.count >= T) {
    const extra = largestRemainder(weights, input.count - T);
    quotas = extra.map((e) => 1 + e);
  } else {
    quotas = largestRemainder(weights, input.count);
  }

  const questionIds: string[] = [];
  const perTopicSelections: string[][] = [];
  let shortfall = 0;

  topics.forEach((topic, t) => {
    const need = quotas[t] ?? 0;
    const rng = seededRandom(input.seed, topic.topicId);
    const pool = input.candidates.filter((c) => c.topicId === topic.topicId);
    // Unseen questions first, then questions last seen more than 7 days ago; shuffled within each tier.
    const unseen = pool.filter((c) => c.daysSinceSeen === null);
    const seenLongAgo = pool.filter((c) => c.daysSinceSeen !== null && c.daysSinceSeen > 7);
    const primary = [...seededShuffle(unseen, rng), ...seededShuffle(seenLongAgo, rng)];
    const fallback = pool
      .filter((c) => c.daysSinceSeen !== null && c.daysSinceSeen <= 7)
      .sort((a, b) => (b.daysSinceSeen ?? 0) - (a.daysSinceSeen ?? 0) || compareStrings(a.questionId, b.questionId));

    const chosen: SimuladoCandidate[] = [];
    const taken = new Set<string>();
    const bucketNeeds = largestRemainder([...SIMULADO_BUCKET_SHARES], need);
    bucketNeeds.forEach((quota, b) => {
      for (const c of primary) {
        if (chosen.length >= need) break;
        if (taken.has(c.questionId) || bucketOf(c.difficulty) !== b) continue;
        if (chosen.filter((x) => bucketOf(x.difficulty) === b).length >= quota) break;
        chosen.push(c);
        taken.add(c.questionId);
      }
    });
    for (const c of primary) {
      if (chosen.length >= need) break;
      if (!taken.has(c.questionId)) {
        chosen.push(c);
        taken.add(c.questionId);
      }
    }
    for (const c of fallback) {
      if (chosen.length >= need) break;
      if (!taken.has(c.questionId)) {
        chosen.push(c);
        taken.add(c.questionId);
      }
    }
    shortfall += Math.max(0, need - chosen.length);
    perTopicSelections.push(chosen.map((c) => c.questionId));
  });

  if (input.order === 'interleaved') {
    const max = Math.max(0, ...perTopicSelections.map((s) => s.length));
    for (let i = 0; i < max; i++) {
      for (const list of perTopicSelections) {
        const id = list[i];
        if (id !== undefined) questionIds.push(id);
      }
    }
  } else {
    for (const list of perTopicSelections) questionIds.push(...list);
  }

  const perTopic: Record<string, number> = {};
  topics.forEach((topic, t) => {
    perTopic[topic.topicId] = perTopicSelections[t]?.length ?? 0;
  });
  return { questionIds, perTopic, shortfall };
}

/** Simulado grade = round1(score_pct × scale_max), shown with a decimal comma (§6.4 step 6). */
export function simuladoGrade(correctPoints: number, totalPoints: number, scaleMax = 10): number {
  if (totalPoints <= 0) return 0;
  return round1((correctPoints / totalPoints) * scaleMax);
}

// ---------- empirical difficulty (§6.5) ----------

export interface EmpiricalStat {
  questionId: string;
  subjectId: string;
  /** Number of first attempts across the shared subject. */
  firstAttempts: number;
  /** Share of first attempts answered correctly. */
  pCorrectFirst: number;
}

/**
 * Empirical difficulty band 1–5 for questions with ≥ 20 first attempts (§6.5):
 * error = 1 − p_correct_first, then quintiles of the subject's eligible questions. Equal errors share a band.
 * Questions below the threshold are absent from the result (keep the generator's estimate).
 */
export function empiricalDifficultyBands(stats: readonly EmpiricalStat[]): Map<string, number> {
  const out = new Map<string, number>();
  const bySubject = new Map<string, EmpiricalStat[]>();
  for (const s of stats) {
    if (s.firstAttempts < SELECTION.empiricalMinAttempts) continue;
    const list = bySubject.get(s.subjectId) ?? [];
    list.push(s);
    bySubject.set(s.subjectId, list);
  }
  for (const list of bySubject.values()) {
    const errors = list.map((s) => 1 - s.pCorrectFirst);
    const n = list.length;
    list.forEach((s, i) => {
      const e = errors[i] ?? 0;
      const rank = errors.filter((x) => x < e).length;
      out.set(s.questionId, Math.min(5, Math.floor((rank * 5) / n) + 1));
    });
  }
  return out;
}

// ---------- Me testa (§6.6, spec 03 §8.4) ----------

export type RecallKind = 'recall' | 'understanding' | 'application';

const RECALL_TARGET: Readonly<Record<RecallKind, number>> = {
  recall: 0.4,
  understanding: 0.4,
  application: 0.2,
};

/**
 * Difficulty kind for the next round (≈ 40% recall / 40% understanding / 20% application). Picks the
 * kind furthest below its target share so far; ties go to the earlier kind in the order above.
 */
export function nextRecallKind(history: readonly RecallKind[]): RecallKind {
  const kinds: RecallKind[] = ['recall', 'understanding', 'application'];
  let best: RecallKind = 'recall';
  let bestDeficit = Number.NEGATIVE_INFINITY;
  for (const kind of kinds) {
    const count = history.filter((h) => h === kind).length;
    const deficit = RECALL_TARGET[kind] * (history.length + 1) - count;
    if (deficit > bestDeficit + 1e-12) {
      best = kind;
      bestDeficit = deficit;
    }
  }
  return best;
}

export interface MeTestaNode {
  nodeId: string;
  mastery: number | null;
  /** Has an open Caderno de Erros entry (phase 2). */
  openCaderno: boolean;
  /** In the scope of the nearest exam (phase 2). */
  nearestExam: boolean;
}

/**
 * Node for the next "Me testa" question (§6.6). Phase 1: uniform over the nodes not asked in the
 * last two rounds. Phase 2: weighted by (1 − m) + 0.3·[open Caderno] + 0.2·[nearest exam], sampled
 * without replacement (one draw per round). Seed: (thread_id, round).
 */
export function pickMeTestaNode(input: {
  phase: 1 | 2;
  nodes: readonly MeTestaNode[];
  recentNodeIds: readonly string[];
  seed: string;
}): string | null {
  const recent = new Set(input.recentNodeIds.slice(-SELECTION.meTestaRecentRounds));
  let pool = input.nodes.filter((n) => !recent.has(n.nodeId));
  if (pool.length === 0) pool = [...input.nodes];
  if (pool.length === 0) return null;
  const rng = seededRandom(input.seed);
  if (input.phase === 1) {
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    return pool[index]?.nodeId ?? null;
  }
  const weights = pool.map(
    (n) => (1 - (n.mastery ?? MASTERY_DEFAULTS.adaptive)) + (n.openCaderno ? 0.3 : 0) + (n.nearestExam ? 0.2 : 0),
  );
  const [first] = weightedSampleWithoutReplacement(pool, weights, 1, rng);
  return first?.nodeId ?? null;
}

// ---------- duels (§6.7, spec 10 §8.2) ----------

export interface DuelCandidate {
  questionId: string;
  topicId: string;
  /** Difficulty 1–5 (empirical band when available). */
  difficulty: number;
  /** Days since either player answered it (null = neither). */
  daysSinceAnswered: number | null;
}

export interface DuelSelectionInput {
  duelId: string;
  candidates: readonly DuelCandidate[];
  /** Average of both players' mastery on the chosen topics. */
  targetMastery: number;
  count: number;
  topicCount: number;
}

const DUEL_SHARES = { easy: 0.3, hard: 0.2 } as const;

/**
 * Duel pool and draw (§6.7). Exclusion relaxes from 7 days to 3 days to none when the pool is too
 * small. Each question is banded by p̂ at the average mastery: easy ≥ 0.75, hard < 0.55, otherwise
 * medium. The draw is about 30% easy, 50% medium, 20% hard, with at most ceil(n/topics)+1 per topic.
 */
export function selectDuelQuestions(input: DuelSelectionInput): string[] {
  let pool: DuelCandidate[] = [];
  for (const threshold of [7, 3, 0]) {
    pool = input.candidates.filter((c) => c.daysSinceAnswered === null || c.daysSinceAnswered >= threshold);
    if (pool.length >= input.count) break;
  }

  const bandOf = (c: DuelCandidate): 'easy' | 'medium' | 'hard' => {
    const p = predictSuccess({ difficulty: c.difficulty, conceptMasteries: [input.targetMastery] });
    if (p >= 0.75) return 'easy';
    if (p < 0.55) return 'hard';
    return 'medium';
  };

  const n = input.count;
  const easyNeed = Math.round(DUEL_SHARES.easy * n);
  const hardNeed = Math.round(DUEL_SHARES.hard * n);
  const mediumNeed = Math.max(0, n - easyNeed - hardNeed);
  const perTopicCap = input.topicCount > 0 ? Math.ceil(n / input.topicCount) + 1 : Number.POSITIVE_INFINITY;

  const rng = seededRandom(input.duelId);
  const bands = { easy: [] as DuelCandidate[], medium: [] as DuelCandidate[], hard: [] as DuelCandidate[] };
  for (const c of seededShuffle(pool, rng)) bands[bandOf(c)].push(c);

  const chosen: DuelCandidate[] = [];
  const perTopic = new Map<string, number>();
  const taken = new Set<string>();
  const tryTake = (c: DuelCandidate): boolean => {
    if (taken.has(c.questionId)) return false;
    if ((perTopic.get(c.topicId) ?? 0) >= perTopicCap) return false;
    chosen.push(c);
    taken.add(c.questionId);
    perTopic.set(c.topicId, (perTopic.get(c.topicId) ?? 0) + 1);
    return true;
  };
  const fill = (list: readonly DuelCandidate[], need: number): number => {
    let got = 0;
    for (const c of list) {
      if (got >= need) break;
      if (tryTake(c)) got += 1;
    }
    return got;
  };

  fill(bands.easy, easyNeed);
  fill(bands.medium, mediumNeed);
  fill(bands.hard, hardNeed);
  // Top up from any band when a band is short, keeping the per-topic cap.
  if (chosen.length < n) {
    fill([...bands.medium, ...bands.easy, ...bands.hard], n - chosen.length);
  }
  return seededShuffle(chosen, seededRandom(input.duelId, 'order')).map((c) => c.questionId);
}

