// Medidor de Confiança (learning-engine §8; PRA-05, spec 05 §8.8).
import { CALIBRATION } from './params.ts';
import { addDays, DEFAULT_TIME_ZONE, studyDay } from './time.ts';
import type { Confidence, LocalDate } from './types.ts';

export interface RatedAnswer {
  /** Bucket for the insight: a topic id, or any grouping the caller uses. */
  bucketId: string;
  confidence: Confidence;
  /** Score in [0, 1]. Correct = 1. */
  score: number;
  numOptions: number;
  trueFalse: boolean;
  answeredAt: Date;
}

/** expected(level, q): 1 → 1/num_options (0.5 for true/false); 2 → 0.55; 3 → 0.75; 4 → 0.95. */
export function expectedConfidence(level: Confidence, numOptions: number, trueFalse: boolean): number {
  if (level === 1) return trueFalse ? 0.5 : 1 / Math.max(1, numOptions);
  return CALIBRATION.expectedByLevel[level];
}

/** Brier score: mean((expected − score)²). `null` when there are no pairs. */
export function brierScore(pairs: ReadonlyArray<{ expected: number; score: number }>): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const p of pairs) sum += (p.expected - p.score) ** 2;
  return sum / pairs.length;
}

export type CalibrationState = 'overconfident' | 'underconfident' | 'ok' | 'insufficient';

export interface CalibrationBucket {
  bucketId: string;
  n: number;
  accuracy: number;
  meanExpected: number;
  /** mean(expected) − accuracy. Positive means overconfident. */
  gap: number;
  state: CalibrationState;
}

export interface ReliabilityBin {
  level: Confidence;
  n: number;
  meanExpected: number | null;
  accuracy: number | null;
}

export interface CalibrationReport {
  overall: { n: number; accuracy: number | null; meanExpected: number | null; gap: number | null; brier: number | null };
  buckets: CalibrationBucket[];
  /** At most two insights (overconfident or underconfident buckets with n ≥ 10), largest |gap| first. */
  insights: CalibrationBucket[];
  /** One bin per confidence level 1–4. */
  reliability: ReliabilityBin[];
  /** Brier per study week (keyed by its Monday). */
  weeklyBrier: Array<{ weekStart: LocalDate; n: number; brier: number }>;
  /** "Bem calibrado": last 50 rated answers with |gap| ≤ 0.10. */
  calibrated: boolean;
}

function classify(n: number, gap: number): CalibrationState {
  if (n < CALIBRATION.minBucketN) return 'insufficient';
  if (gap >= CALIBRATION.gapThreshold) return 'overconfident';
  if (gap <= -CALIBRATION.gapThreshold) return 'underconfident';
  return 'ok';
}

function weekStartOf(day: LocalDate): LocalDate {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/**
 * Calibration report (§8). Gaps and insights use only buckets with n ≥ 10 rated answers.
 * `timeZone` defines the study weeks for the Brier trend.
 */
export function calibration(answers: readonly RatedAnswer[], timeZone: string = DEFAULT_TIME_ZONE): CalibrationReport {
  const rows = answers.map((a) => ({
    bucketId: a.bucketId,
    score: a.score,
    answeredAt: a.answeredAt,
    expected: expectedConfidence(a.confidence, a.numOptions, a.trueFalse),
    level: a.confidence,
  }));

  const overallN = rows.length;
  const overallAcc = overallN ? rows.reduce((s, r) => s + r.score, 0) / overallN : null;
  const overallExp = overallN ? rows.reduce((s, r) => s + r.expected, 0) / overallN : null;
  const overall = {
    n: overallN,
    accuracy: overallAcc,
    meanExpected: overallExp,
    gap: overallAcc === null || overallExp === null ? null : overallExp - overallAcc,
    brier: brierScore(rows.map((r) => ({ expected: r.expected, score: r.score }))),
  };

  const byBucket = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byBucket.get(r.bucketId) ?? [];
    list.push(r);
    byBucket.set(r.bucketId, list);
  }
  const buckets: CalibrationBucket[] = [...byBucket.keys()].sort().map((bucketId) => {
    const list = byBucket.get(bucketId) ?? [];
    const n = list.length;
    const accuracy = list.reduce((s, r) => s + r.score, 0) / n;
    const meanExpected = list.reduce((s, r) => s + r.expected, 0) / n;
    const gap = meanExpected - accuracy;
    return { bucketId, n, accuracy, meanExpected, gap, state: classify(n, gap) };
  });

  const insights = buckets
    .filter((b) => b.state === 'overconfident' || b.state === 'underconfident')
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.bucketId.localeCompare(b.bucketId))
    .slice(0, CALIBRATION.insightLimit);

  const reliability: ReliabilityBin[] = ([1, 2, 3, 4] as const).map((level) => {
    const list = rows.filter((r) => r.level === level);
    const n = list.length;
    return {
      level,
      n,
      meanExpected: n ? list.reduce((s, r) => s + r.expected, 0) / n : null,
      accuracy: n ? list.reduce((s, r) => s + r.score, 0) / n : null,
    };
  });

  const weeks = new Map<LocalDate, Array<{ expected: number; score: number }>>();
  for (const r of rows) {
    const week = weekStartOf(studyDay(r.answeredAt, timeZone));
    const list = weeks.get(week) ?? [];
    list.push({ expected: r.expected, score: r.score });
    weeks.set(week, list);
  }
  const weeklyBrier = [...weeks.keys()].sort().map((weekStart) => {
    const pairs = weeks.get(weekStart) ?? [];
    return { weekStart, n: pairs.length, brier: brierScore(pairs) ?? 0 };
  });

  const recent = [...rows].sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime()).slice(-CALIBRATION.calibratedWindow);
  let calibrated = false;
  if (rows.length >= CALIBRATION.calibratedWindow) {
    const gap = recent.reduce((s, r) => s + r.expected - r.score, 0) / recent.length;
    calibrated = Math.abs(gap) <= CALIBRATION.calibratedGap;
  }

  return { overall, buckets, insights, reliability, weeklyBrier, calibrated };
}

/** Effects of an overconfident bucket: +0.2 in adaptive selection (§6.3) and ×1.15 planner priority (§11.4). */
export function isOverconfident(bucket: Pick<CalibrationBucket, 'state'>): boolean {
  return bucket.state === 'overconfident';
}
