// Review queue, exam overlay and review-load forecast (learning-engine §3, spec 04 §8.3–8.5).
import { EXAM_WINDOW_DAYS } from './params.ts';
import { retrievability, isIntroduced, scheduleReview } from './fsrs.ts';
import { addDays, daysBetween, daysUntil, endOfStudyDay, maxDay, startOfStudyDay, studyDay } from './time.ts';
import type { CardState, ExamScope, ForecastDay, LearningParams, LocalDate, QueueEntry } from './types.ts';
import { compareStrings, median } from './util.ts';

/** A card as the queue sees it: the FSRS state plus the labels the queue needs. */
export interface QueueCard {
  cardId: string;
  subjectId: string;
  /** Concept node; exam scopes are matched on it. */
  conceptId: string;
  /** Knowledge-map order (unit → topic → concept index). Ties in new-card order. */
  mapOrder: number;
  state: CardState;
  /** Sibling group (same source note). Siblings of a reviewed card are buried until the next study day (MEM-02.7). */
  siblingGroupId?: string | null;
  /** MEM-02.7: a sibling of a card reviewed on this study day. */
  buried?: boolean;
  /** Hidden, archived, marked "não cai na prova" or otherwise out of the queue. */
  excluded?: boolean;
}

export interface QueueInput {
  cards: readonly QueueCard[];
  exams: readonly ExamScope[];
  params: LearningParams;
  /** newCardQuota.total − introduced today (§3.1 step 3). */
  newQuota: number;
  /** Daily cap for due reviews. Defaults to params.maxReviewsPerDay; recovery mode (§2.4) lowers it. */
  dailyCap?: number;
}

/**
 * MEM-02.7 sibling burying: after `reviewedCardId` is reviewed, these cards (same sibling group, not
 * the card itself) are buried until the next study day. The caller sets `buried` on them.
 */
export function siblingsToBury(
  reviewedCardId: string,
  cards: ReadonlyArray<Pick<QueueCard, 'cardId' | 'siblingGroupId'>>,
): string[] {
  const reviewed = cards.find((c) => c.cardId === reviewedCardId);
  if (!reviewed || !reviewed.siblingGroupId) return [];
  return cards
    .filter((c) => c.cardId !== reviewedCardId && c.siblingGroupId === reviewed.siblingGroupId)
    .map((c) => c.cardId)
    .sort(compareStrings);
}

export interface EffectiveDue {
  at: Date;
  examId: string | null;
}

const RETRIEVABILITY_FALLBACK = 0;

/** Scheduled exams that have not started, within the overlay window, sorted for determinism. */
export function activeExamScopes(exams: readonly ExamScope[], now: Date, params: LearningParams): ExamScope[] {
  return exams
    .filter((e) => e.status === 'scheduled' && e.startsAt.getTime() > now.getTime())
    .filter((e) => daysUntil(e.startsAt, now, params.timeZone) <= EXAM_WINDOW_DAYS)
    .sort(compareExams);
}

function compareExams(a: ExamScope, b: ExamScope): number {
  return a.startsAt.getTime() - b.startsAt.getTime() || compareStrings(a.examId, b.examId);
}

/**
 * Exam overlay (§3.2, MEM-02.5). Returns the instant from which the card should be reviewed for
 * exam `exam`, or null when FSRS already handles it. Never modifies the FSRS state.
 */
export function examDue(state: CardState, exam: ExamScope, now: Date, params: LearningParams): Date | null {
  if (exam.status !== 'scheduled' || state.suspended || !isIntroduced(state)) return null;
  const tz = params.timeZone;
  const startsAt = exam.startsAt;
  if (startsAt.getTime() <= now.getTime()) return null;
  if (daysUntil(startsAt, now, tz) > EXAM_WINDOW_DAYS) return null;

  // FSRS will show it first when it is due earlier than the day before the exam (re-evaluated after that review).
  const examDay = studyDay(startsAt, tz);
  if (state.due.getTime() < startOfStudyDay(addDays(examDay, -1), tz).getTime()) return null;

  const rExam = retrievability(state, startsAt, params);
  if (rExam === null || rExam >= params.rExam) return null;

  const d = rExam >= 0.75 ? 1 : 3;
  const dueDay: LocalDate = maxDay(studyDay(now, tz), addDays(examDay, -d));
  return startOfStudyDay(dueDay, tz);
}

/**
 * effectiveDue = min(fsrsDue, min over the exams containing the card of examDue) (§3.2).
 * `exams` should be the exams whose scope contains the card's concept.
 */
export function effectiveDue(state: CardState, exams: readonly ExamScope[], now: Date, params: LearningParams): EffectiveDue {
  let best: EffectiveDue = { at: state.due, examId: null };
  for (const exam of [...exams].sort(compareExams)) {
    const due = examDue(state, exam, now, params);
    if (due && due.getTime() < best.at.getTime()) best = { at: due, examId: exam.examId };
  }
  return best;
}

/** Exams whose scope contains `conceptId`. */
export function examsForConcept(exams: readonly ExamScope[], conceptId: string): ExamScope[] {
  return exams.filter((e) => e.nodeIds.includes(conceptId));
}

/** exam_factor step function of the overflow priority (§3.1). */
function examFactor(exams: readonly ExamScope[], now: Date, params: LearningParams): number {
  const active = activeExamScopes(exams, now, params);
  const earliest = active[0];
  if (!earliest) return 0;
  const days = daysUntil(earliest.startsAt, now, params.timeZone);
  const step = days <= 7 ? 1 : days <= 14 ? 0.5 : 0;
  return earliest.weightNorm * step;
}

/**
 * Builds the study-day review queue (§3.1, spec 04 §8.3). Order:
 *  1. learning/relearning cards whose step is due, by due time;
 *  2. due reviews (effective due ≤ end of today), by effective due then retrievability, capped by
 *     `dailyCap` using priority (1 − R)·(1 + exam_factor);
 *  3. new cards up to `newQuota`, soonest exam first, then knowledge-map order, interleaved
 *     with reviews (one new card after every four reviews).
 */
export function buildReviewQueue(input: QueueInput, now: Date): QueueEntry[] {
  const { params } = input;
  const tz = params.timeZone;
  const dayEnd = endOfStudyDay(studyDay(now, tz), tz);
  const cap = input.dailyCap ?? params.maxReviewsPerDay;
  const exams = [...input.exams];

  const learning: QueueEntry[] = [];
  const reviews: Array<{ card: QueueCard; due: Date; examId: string | null; r: number }> = [];
  const news: QueueCard[] = [];

  for (const card of input.cards) {
    if (card.excluded || card.buried || card.state.suspended) continue;
    const s = card.state;
    if (s.state === 'learning' || s.state === 'relearning') {
      if (s.due.getTime() <= now.getTime()) {
        learning.push({
          cardId: card.cardId,
          kind: 'learning',
          due: s.due,
          reason: 'learning',
          examId: null,
          retrievability: retrievability(s, now, params),
        });
      }
    } else if (s.state === 'review' && isIntroduced(s)) {
      const cardExams = examsForConcept(exams, card.conceptId);
      const eff = effectiveDue(s, cardExams, now, params);
      if (eff.at.getTime() <= dayEnd.getTime()) {
        reviews.push({ card, due: eff.at, examId: eff.examId, r: retrievability(s, now, params) ?? RETRIEVABILITY_FALLBACK });
      }
    } else if (s.state === 'new' && !isIntroduced(s)) {
      news.push(card);
    }
  }

  reviews.sort((a, b) => a.due.getTime() - b.due.getTime() || a.r - b.r || compareStrings(a.card.cardId, b.card.cardId));

  let kept = reviews;
  if (reviews.length > cap) {
    const ranked = reviews
      .map((item, index) => ({
        item,
        index,
        priority: (1 - item.r) * (1 + examFactor(examsForConcept(exams, item.card.conceptId), now, params)),
      }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index)
      .slice(0, Math.max(0, cap))
      .map((x) => x.index);
    const keep = new Set(ranked);
    kept = reviews.filter((_, index) => keep.has(index));
  }

  const reviewEntries: QueueEntry[] = kept.map((item) => ({
    cardId: item.card.cardId,
    kind: 'review',
    due: item.due,
    reason: item.examId ? 'exam_boost' : 'due',
    examId: item.examId,
    retrievability: item.r,
  }));

  const nextExamStart = (conceptId: string): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const e of examsForConcept(exams, conceptId)) {
      if (e.status === 'scheduled' && e.startsAt.getTime() > now.getTime()) {
        best = Math.min(best, e.startsAt.getTime());
      }
    }
    return best;
  };
  const newOrdered = news
    .map((card) => ({ card, examAt: nextExamStart(card.conceptId) }))
    .sort((a, b) => a.examAt - b.examAt || a.card.mapOrder - b.card.mapOrder || compareStrings(a.card.cardId, b.card.cardId))
    .slice(0, Math.max(0, input.newQuota))
    .map((x) => x.card);

  const newEntries: QueueEntry[] = newOrdered.map((card) => ({
    cardId: card.cardId,
    kind: 'new',
    due: card.state.due,
    reason: 'new',
    examId: null,
    retrievability: null,
  }));

  return [...learning, ...interleaveNew(reviewEntries, newEntries)];
}

/** §3.1 step 3: one new card after every four reviews; any leftover new cards follow. */
function interleaveNew(reviews: readonly QueueEntry[], news: readonly QueueEntry[]): QueueEntry[] {
  const out: QueueEntry[] = [];
  let newIndex = 0;
  reviews.forEach((review, i) => {
    out.push(review);
    if ((i + 1) % 4 === 0 && newIndex < news.length) {
      const next = news[newIndex];
      if (next) out.push(next);
      newIndex += 1;
    }
  });
  out.push(...news.slice(newIndex));
  return out;
}

export interface ForecastOptions {
  /** Seconds per review. Defaults to params.reviewSecondsDefault (§3.4). */
  reviewSeconds?: number;
  /** New cards planned per study day (§4). Each adds ≈3 reviews on days +1, +3 and +7 (spec 07 §8.3.3). */
  newCardsPlanned?: Readonly<Record<LocalDate, number>>;
}

const NEW_CARD_REVIEW_OFFSETS = [1, 3, 7] as const;
const FORECAST_MAX_STEPS = 400;
const GOOD: 3 = 3;

/**
 * Review load per study day from `from` to `to` inclusive (§3.4). Each card is simulated forward
 * along the expected path (Good at each effective due, ts-fsrs), so the forecast matches what the
 * queue will show. Exam overlay is evaluated at each simulated review time.
 */
export function forecastReviewLoad(
  cards: readonly QueueCard[],
  exams: readonly ExamScope[],
  from: LocalDate,
  to: LocalDate,
  now: Date,
  params: LearningParams,
  options: ForecastOptions = {},
): ForecastDay[] {
  const tz = params.timeZone;
  const dueByDay = new Map<LocalDate, number>();
  const boostByDay = new Map<LocalDate, number>();
  const bump = (map: Map<LocalDate, number>, day: LocalDate, by = 1): void => {
    map.set(day, (map.get(day) ?? 0) + by);
  };

  for (const card of cards) {
    if (card.excluded || card.state.suspended || card.state.state === 'new') continue;
    const cardExams = examsForConcept(exams, card.conceptId);
    let s = card.state;
    let eff = effectiveDue(s, cardExams, now, params);
    let occurrence = new Date(Math.max(eff.at.getTime(), now.getTime()));
    for (let step = 0; step < FORECAST_MAX_STEPS; step++) {
      const day = studyDay(occurrence, tz);
      if (day > to) break;
      if (day >= from) {
        if (eff.examId) bump(boostByDay, day);
        else bump(dueByDay, day);
      }
      s = scheduleReview(s, GOOD, occurrence, params).next;
      eff = effectiveDue(s, cardExams, occurrence, params);
      // One expected review per study day at most: keeps a card that the overlay keeps due from piling up.
      const nextDayStart = startOfStudyDay(addDays(studyDay(occurrence, tz), 1), tz);
      occurrence = new Date(Math.max(eff.at.getTime(), nextDayStart.getTime()));
    }
  }

  for (const [day, count] of Object.entries(options.newCardsPlanned ?? {})) {
    for (const offset of NEW_CARD_REVIEW_OFFSETS) {
      const target = addDays(day, offset);
      if (target >= from && target <= to) bump(dueByDay, target, count);
    }
  }

  const reviewSeconds = options.reviewSeconds ?? params.reviewSecondsDefault;
  const out: ForecastDay[] = [];
  const span = daysBetween(from, to);
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const dueCount = dueByDay.get(date) ?? 0;
    const examBoostCount = boostByDay.get(date) ?? 0;
    out.push({ date, dueCount, examBoostCount, estMinutes: ((dueCount + examBoostCount) * reviewSeconds) / 60 });
  }
  return out;
}

/** reviewSeconds = median duration of the user's recent reviews, capped at 60 s per log (§3.4, MEM-02.9). */
export function medianReviewSeconds(durationsMs: readonly number[], fallbackSeconds = 10): number {
  const capped = durationsMs.map((ms) => Math.min(Math.max(ms, 0), 60_000) / 1000).filter((s) => s > 0);
  const m = median(capped.slice(-200));
  return m ?? fallbackSeconds;
}
