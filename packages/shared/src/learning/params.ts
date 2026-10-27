// Default parameters for the learning engine (learning-engine §0.3: defaults live here).
import { default_w } from 'ts-fsrs';
import { DEFAULT_TIME_ZONE } from './time.ts';
import type { LearningParams } from './types.ts';

/** MEM-02.3 defaults. `rExam` follows requestRetention (§3.2). */
export const DEFAULT_LEARNING_PARAMS: Readonly<LearningParams> = Object.freeze({
  requestRetention: 0.9,
  rExam: 0.9,
  maximumInterval: 365,
  maxReviewsPerDay: 200,
  newPerDayNoPlan: 20,
  enableFuzz: true,
  enableShortTerm: true,
  learningSteps: Object.freeze(['1m', '10m']),
  relearningSteps: Object.freeze(['10m']),
  weights: Object.freeze([...default_w]),
  reviewSecondsDefault: 10,
  timeZone: DEFAULT_TIME_ZONE,
});

/** Merge user or server overrides over the defaults. `rExam` follows `requestRetention` unless set. */
export function resolveParams(overrides: Partial<LearningParams> = {}): LearningParams {
  const merged: LearningParams = { ...DEFAULT_LEARNING_PARAMS, ...overrides, weights: overrides.weights ?? DEFAULT_LEARNING_PARAMS.weights };
  if (overrides.rExam === undefined) merged.rExam = merged.requestRetention;
  return merged;
}

/** Exam overlay window (§3.2): exams starting within this many days. */
export const EXAM_WINDOW_DAYS = 14;

/** New-card quota (§4). */
export const QUOTA = {
  cap: 50,
  /** Share of today's planned learn minutes that becomes new cards. */
  learnShare: 0.25,
  /** Seconds per new card used to convert minutes into a count. */
  secondsPerNewCard: 20,
  /** Horizon for exams that contribute to `required`. */
  requiredHorizonDays: 30,
  /** Future-load protection: forecast(next 7 days) ≤ this share of available minutes. */
  futureLoadShare: 0.5,
  futureLoadDays: 7,
} as const;

/** Mastery (§5). */
export const MASTERY = {
  /** Half-life for evidence decay, days (§5.1, L8). */
  halfLifeDays: 7,
  /** Weight of card retrievability when a node has both cards and question evidence (§5.1). */
  lambdaBoth: 0.5,
  /** Question-based retrievability is used at or above this many evidence events (§5.1). */
  questionRetrievabilityMinEvidence: 3,
  /** `studied` thresholds (§5.1). */
  studiedCardReviews: 5,
  studiedQuestions: 3,
  /** Mastery shift threshold (§5.5). */
  shiftThreshold: 0.15,
} as const;

/** Defaults when mastery is null (§5.4). */
export const MASTERY_DEFAULTS = {
  planner: 0,
  feed: 0.5,
  adaptive: 0.5,
  enemTopic: 0.3,
} as const;

/** Question selection (§6). */
export const SELECTION = {
  alpha: 1.5,
  beta0: 1.1,
  /** Refit needs at least this many first attempts per subject (§6.1). */
  refitMinAttempts: 200,
  /** Shrinkage weight toward the defaults (§6.1). */
  refitShrink: 50,
  targetSuccess: 0.72,
  unseenBonus: 0.3,
  overconfidentBonus: 0.2,
  examUrgencyWeight: 0.3,
  maxPerConcept: 2,
  minTypes: 3,
  recentCorrectDays: 7,
  /** Empirical difficulty needs this many first attempts (§6.5). */
  empiricalMinAttempts: 20,
  meTestaRecentRounds: 2,
} as const;

/** Caderno de Erros (§7). */
export const MISTAKES = {
  retryOffsets: [1, 3, 7] as readonly number[],
  correctDaysToResolve: 2,
} as const;

/** Medidor de Confiança (§8). */
export const CALIBRATION = {
  expectedByLevel: { 2: 0.55, 3: 0.75, 4: 0.95 } as const,
  minBucketN: 10,
  gapThreshold: 0.15,
  insightLimit: 2,
  calibratedGap: 0.1,
  calibratedWindow: 50,
} as const;

/** Feed ranking (§10). */
export const FEED = {
  jitter: 0.05,
  recentWindow: 3,
} as const;

/** Leeches (§2.3) and backlog (§2.4). */
export const LEECH = { threshold: 6, repromptEvery: 3 } as const;
export const BACKLOG = { multiple: 3, maxDays: 7 } as const;

/** Clock skew tolerance for device timestamps (§0.2). */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** Cross-device double review window (§2.6). */
export const CROSS_DEVICE_WINDOW_MS = 60_000;

/** Motivation (§17). */
export const MOTIVATION = {
  countedMinutes: 5,
  countedReviews: 10,
  shieldsMax: 2,
  shieldEveryCountedDays: 7,
  activeIdleGapMs: 90_000,
  noteXpDailyCap: 20,
  podcastDailyCap: 3,
  dailyGoalXp: 10,
} as const;

/** Social scoring (§18). */
export const SOCIAL = {
  duelMaxSeconds: 30,
  duelDeadlineGraceMs: 1_500,
  battleMaxSeconds: 30,
  battleClosesGraceMs: 1_000,
  battleStreakStep: 50,
  battleStreakCap: 200,
  insightK: 5,
} as const;
