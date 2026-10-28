// The student's measured study speed (spec 07 §8.2.1, learning-engine §11.1): κ, the pace factor applied to
// est_learn_minutes, and the seconds a flashcard review takes. Pure: callers load the sessions and review logs.
import { clamp } from './util.ts';

/** One finished learn block: minutes the plan gave it and minutes the student's session actually took. */
export interface PaceSample {
  subjectId: string | null;
  plannedMinutes: number;
  actualMinutes: number;
  /** Epoch milliseconds of the session; samples are folded oldest first. */
  at: number;
}

/** EMA weight of each new session (spec 07 §8.2.1). */
export const PACE_ALPHA = 0.3;
export const PACE_MIN = 0.5;
export const PACE_MAX = 2;
/** Sessions needed before a pace (global or per subject) replaces the default of 1. */
export const PACE_MIN_SAMPLES = 3;
/** One session counts at most this far from the plan (a forgotten timer, a block cut short). */
const RATIO_MIN = 0.25;
const RATIO_MAX = 4;

function ema(samples: readonly PaceSample[]): number {
  let k = 1;
  for (const s of samples) k = (1 - PACE_ALPHA) * k + PACE_ALPHA * clamp(s.actualMinutes / s.plannedMinutes, RATIO_MIN, RATIO_MAX);
  return clamp(k, PACE_MIN, PACE_MAX);
}

/**
 * κ for the student overall and per subject. A subject with fewer than PACE_MIN_SAMPLES sessions uses the overall
 * pace, and the overall pace stays 1 until the student has PACE_MIN_SAMPLES sessions.
 */
export function learnPace(samples: readonly PaceSample[]): { overall: number; bySubject: Map<string, number> } {
  const valid = samples.filter((s) => s.plannedMinutes > 0 && s.actualMinutes > 0).slice().sort((a, b) => a.at - b.at);
  const overall = valid.length >= PACE_MIN_SAMPLES ? ema(valid) : 1;
  const groups = new Map<string, PaceSample[]>();
  for (const s of valid) {
    if (!s.subjectId) continue;
    groups.set(s.subjectId, [...(groups.get(s.subjectId) ?? []), s]);
  }
  const bySubject = new Map<string, number>();
  for (const [subject, list] of groups) bySubject.set(subject, list.length >= PACE_MIN_SAMPLES ? ema(list) : overall);
  return { overall, bySubject };
}

/** Reviews needed before the measured time replaces the default. */
export const REVIEW_SECONDS_MIN_SAMPLES = 20;

/**
 * Seconds per flashcard review: the median of the last 200 review durations between 1 s and 2 min (longer ones are
 * the app left open), clamped to 3–60 s; `fallback` with fewer than REVIEW_SECONDS_MIN_SAMPLES usable reviews.
 */
export function reviewSecondsFrom(durationsMs: readonly number[], fallback: number): number {
  const usable = durationsMs.slice(-200).filter((ms) => ms >= 1_000 && ms <= 120_000).sort((a, b) => a - b);
  if (usable.length < REVIEW_SECONDS_MIN_SAMPLES) return fallback;
  const mid = Math.floor(usable.length / 2);
  const median = usable.length % 2 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2;
  return clamp(median / 1000, 3, 60);
}
