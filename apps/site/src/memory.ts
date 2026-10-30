// The landing page forgets itself. Every sheet of the "apostila" holds a memory trace that fades on the same
// forgetting curve the app schedules cards with (FSRS via ts-fsrs, default weights, as in
// packages/shared/src/learning/params.ts), on a faster clock: one second on the page is one hour.
import { FSRSAlgorithm, Rating, createEmptyCard, fsrs, generatorParameters, type Grade } from 'ts-fsrs';

/** Page clock speed: page hours per real second. */
export const PAGE_HOURS_PER_SECOND = 1;
/** The page clock starts on day 1 at 19:00, study time after school. */
export const CLOCK_START_HOUR = 19;

// Long-term formulas only: the page measures time in fractional days, not calendar days.
const algorithm = new FSRSAlgorithm(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

/** What the page remembers about one sheet. Times are page hours since the page opened. */
export interface Trace {
  /** When the sheet was last read or recalled. */
  at: number;
  /** FSRS stability in days: the time until retrievability falls to 90%. */
  stability: number;
  difficulty: number;
}

/** Reading once, without recalling anything, leaves the weakest memory FSRS knows: a card you missed. */
export function firstRead(at: number): Trace {
  return { at, stability: algorithm.init_stability(Rating.Again), difficulty: algorithm.init_difficulty(Rating.Again) };
}

/** Probability of recalling the sheet at page time `now`; 1 while it is unread. */
export function retrievability(trace: Trace | null, now: number): number {
  if (!trace) return 1;
  return algorithm.forgetting_curve(Math.max(0, now - trace.at) / 24, trace.stability);
}

/** A recall attempt at page time `now`: remembering grows stability (more when it was harder), missing shrinks it. */
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

/** How much ink a sheet has lost, 0 (crisp) to 1 (gone). Starts just under 92% retrievability. */
export function erosion(r: number): number {
  return Math.min(1, Math.max(0, (0.92 - r) / 0.34));
}

export type MemoryLevel = 'unread' | 'strong' | 'ok' | 'fading' | 'almost';

/** The Mapa da Memória labels (ux-guidelines §8.2), with "lido" for a page. */
export const LEVEL_LABEL: Record<MemoryLevel, string> = {
  unread: 'Ainda não lido',
  strong: 'Forte',
  ok: 'Ok',
  fading: 'Apagando',
  almost: 'Quase esquecido',
};

export function levelOf(trace: Trace | null, now: number): MemoryLevel {
  if (!trace) return 'unread';
  const r = retrievability(trace, now);
  if (r >= 0.9) return 'strong';
  if (r >= 0.8) return 'ok';
  if (r >= 0.68) return 'fading';
  return 'almost';
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

/** A page-time span in words: "40 min", "5 horas", "3 dias", "2 meses", "9 anos". */
export function formatSpan(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 36) return plural(Math.round(hours), 'hora', 'horas');
  const days = hours / 24;
  if (days < 60) return plural(Math.round(days), 'dia', 'dias');
  if (days < 730) return plural(Math.round(days / 30), 'mês', 'meses');
  return plural(Math.round(days / 365), 'ano', 'anos');
}

/** The page clock: "Dia 3, 14:05". */
export function formatClock(hours: number): string {
  const total = CLOCK_START_HOUR + Math.max(0, hours);
  const day = Math.floor(total / 24) + 1;
  const minutes = Math.floor((total % 24) * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `Dia ${day.toLocaleString('pt-BR')}, ${hh}:${mm}`;
}

// ---------- the flashcard on p. 2: what the app's rating keys show for a new card ----------

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

// ---------- the plan on p. 3: one card from today to the exam ----------

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
