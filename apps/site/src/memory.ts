// The memory model behind the landing page's demos: the flashcard's rating intervals and the plan chart. It is the
// app's own scheduler (FSRS via ts-fsrs, default weights, as in packages/shared/src/learning/params.ts).
import { FSRSAlgorithm, Rating, createEmptyCard, fsrs, generatorParameters, type Grade } from 'ts-fsrs';

// Long-term formulas only: the plan measures time in fractional days, not calendar days.
const algorithm = new FSRSAlgorithm(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

/** A memory trace. Times are hours since day 0. */
export interface Trace {
  /** When it was last read or recalled. */
  at: number;
  /** FSRS stability in days: the time until retrievability falls to 90%. */
  stability: number;
  difficulty: number;
}

/** Reading once, without recalling anything, leaves the weakest memory FSRS knows: a card you missed. */
export function firstRead(at: number): Trace {
  return { at, stability: algorithm.init_stability(Rating.Again), difficulty: algorithm.init_difficulty(Rating.Again) };
}

/** Probability of recalling at time `now` (hours); 1 with no trace. */
export function retrievability(trace: Trace | null, now: number): number {
  if (!trace) return 1;
  return algorithm.forgetting_curve(Math.max(0, now - trace.at) / 24, trace.stability);
}

/** A recall attempt at time `now`: remembering grows stability (more when it was harder), missing shrinks it. */
export function recall(trace: Trace, now: number, remembered: boolean): Trace {
  const r = retrievability(trace, now);
  const grade: Grade = remembered ? Rating.Good : Rating.Again;
  return {
    at: now,
    stability: remembered
      ? algorithm.next_recall_stability(trace.difficulty, trace.stability, r, grade)
      : algorithm.next_forget_stability(trace.difficulty, trace.stability, r),
    difficulty: algorithm.next_difficulty(trace.difficulty, grade),
  };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

/** A span in words: "40 min", "5 horas", "3 dias", "2 meses", "9 anos". */
export function formatSpan(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 36) return plural(Math.round(hours), 'hora', 'horas');
  const days = hours / 24;
  if (days < 60) return plural(Math.round(days), 'dia', 'dias');
  if (days < 730) return plural(Math.round(days / 30), 'mês', 'meses');
  return plural(Math.round(days / 365), 'ano', 'anos');
}

// ---------- the flashcard: what the app's rating keys show for a new card ----------

const RATING_KEYS = [
  { grade: Rating.Again, label: 'Errei', tone: 'again' },
  { grade: Rating.Hard, label: 'Difícil', tone: 'hard' },
  { grade: Rating.Good, label: 'Bom', tone: 'good' },
  { grade: Rating.Easy, label: 'Fácil', tone: 'easy' },
] as const;

export interface RatingKey {
  label: string;
  tone: 'again' | 'hard' | 'good' | 'easy';
  /** "1 min", "8 dias": when the card comes back, with the app's defaults (learning steps 1m, 10m). */
  interval: string;
}

export function newCardRatings(): RatingKey[] {
  const now = new Date(Date.UTC(2026, 10, 2, 22));
  const next = fsrs(generatorParameters({ enable_fuzz: false })).repeat(createEmptyCard(now), now);
  return RATING_KEYS.map(({ grade, label, tone }) => {
    const minutes = Math.round((next[grade].card.due.getTime() - now.getTime()) / 60_000);
    return { label, tone, interval: minutes < 60 ? `${minutes} min` : formatSpan(minutes / 60) };
  });
}

// ---------- the plan: one card from today to the exam ----------

export interface PlanCurve {
  /** [day, retrievability] samples from day 0 to the exam. */
  readOnly: [number, number][];
  withReviews: [number, number][];
  /** Days with a review (the first study session on day 0 is not one). */
  reviews: number[];
  /** Retrievability on exam day. */
  atExam: { readOnly: number; withReviews: number };
}

/**
 * "Só lendo": the material read once on day 0. "Com o Studify": studied with recall on day 0 (Bom), then reviewed
 * whenever FSRS says it is due at 90% retention, plus Modo Véspera on the night before the exam.
 */
export function planCurve(examDays: number, step = 0.1): PlanCurve {
  const read = firstRead(0);
  let trace: Trace = { at: 0, stability: algorithm.init_stability(Rating.Good), difficulty: algorithm.init_difficulty(Rating.Good) };
  const reviews: number[] = [];
  for (;;) {
    const due = trace.at / 24 + Math.max(1, Math.round(trace.stability));
    if (due >= examDays - 1) break;
    reviews.push(due);
    trace = recall(trace, due * 24, true);
  }
  if (examDays - 1 > (reviews.at(-1) ?? 0)) reviews.push(examDays - 1);

  const readOnly: [number, number][] = [];
  const withReviews: [number, number][] = [];
  let current: Trace = { at: 0, stability: algorithm.init_stability(Rating.Good), difficulty: algorithm.init_difficulty(Rating.Good) };
  let next = 0;
  const samples = Math.round(examDays / step);
  for (let i = 0; i <= samples; i++) {
    const day = i * step;
    while (next < reviews.length && reviews[next]! <= day + 1e-9) {
      const at = reviews[next]!;
      withReviews.push([at, retrievability(current, at * 24)]);
      current = recall(current, at * 24, true);
      withReviews.push([at, 1]);
      next++;
    }
    readOnly.push([day, retrievability(read, day * 24)]);
    withReviews.push([day, retrievability(current, day * 24)]);
  }
  return {
    readOnly,
    withReviews,
    reviews,
    atExam: { readOnly: retrievability(read, examDays * 24), withReviews: retrievability(current, examDays * 24) },
  };
}
