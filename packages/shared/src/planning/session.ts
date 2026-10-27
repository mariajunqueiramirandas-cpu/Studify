// GOL-05 / spec 07 §8.4 — one-button session from today's plan (learning-engine §12).
import type { PlanItemState, PlanUnitKind } from './types.ts';

export interface SessionReviewCard {
  cardId: string;
  /** Card belongs to an in-scope topic of a test (in-scope first, GOL-05). */
  inScope: boolean;
  /** Days overdue; larger first within the same scope group. */
  overdueDays: number;
}

export interface SessionPlanItem {
  id: string;
  unitType: PlanUnitKind;
  topicId: string | null;
  minutes: number;
  orderInDay: number;
  status: PlanItemState;
}

export interface SessionInput {
  dueReviews: SessionReviewCard[];
  /** Median seconds per review (learned per user; default 10). */
  reviewSeconds?: number;
  /** Today's plan items (pending ones are used, in order_in_day). */
  planItems: SessionPlanItem[];
  /** Cards whose first introduction happens in this session (recap, step 4). */
  newCardsFirstSeen?: string[];
  /** Topics in map order with mastery (null = unknown). Used for the weakest-topic quiz (step 5). */
  topics: Array<{ id: string; order: number; mastery: number | null; studied: boolean }>;
}

export type SessionBlock =
  | { kind: 'reviews'; cardIds: string[]; minutes: number }
  | { kind: 'plan_item'; planItemId: string; unitType: PlanUnitKind; topicId: string | null; minutes: number; truncated: boolean }
  | { kind: 'retrieval'; topicId: string | null; questionCount: number; minutes: number }
  | { kind: 'recap'; cardIds: string[]; minutes: number }
  | { kind: 'quiz_weak'; topicId: string; questionCount: number; minutes: number }
  | { kind: 'done' };

export interface SessionPlan {
  targetMinutes: number;
  totalMinutes: number;
  blocks: SessionBlock[];
  /** True when nothing was planned and the fallback (reviews, weakest quiz, "zerou o dia") applies. */
  fallback: boolean;
}

const MIN_BLOCK = 10;

/**
 * Builds a session of `targetMinutes` (GOL-05.2: 10 / 20 / 30 or the remaining planned minutes).
 * 1. Reviews take min(due, 40% of T); with T ≤ 10 only reviews.
 * 2. Plan items in order, truncated to fit (a learn block may be cut at its end, minimum 10 min).
 * 3. After each learn block, a 3–5 question retrieval check (1 min per question here).
 * 4. Close with a 1–2 min recap of cards first seen in this session.
 * 5. Nothing planned: due reviews, then the weakest-topic quiz, then "Você zerou o dia!".
 */
export function buildSession(input: SessionInput, targetMinutes: number): SessionPlan {
  const T = Math.max(0, Math.floor(targetMinutes));
  const reviewSeconds = input.reviewSeconds ?? 10;
  const due = input.dueReviews
    .slice()
    .sort((a, b) => Number(b.inScope) - Number(a.inScope) || b.overdueDays - a.overdueDays || (a.cardId < b.cardId ? -1 : 1));
  const pending = input.planItems
    .filter((i) => i.status === 'planned')
    .sort((a, b) => a.orderInDay - b.orderInDay || (a.id < b.id ? -1 : 1));

  if (T === 0) return { targetMinutes: T, totalMinutes: 0, blocks: [{ kind: 'done' }], fallback: true };

  if (pending.length === 0) {
    const maxReviews = Math.floor((T * 60) / reviewSeconds);
    const count = Math.min(due.length, maxReviews);
    const blocks: SessionBlock[] = [];
    let total = 0;
    if (count > 0) {
      const minutes = Math.ceil((count * reviewSeconds) / 60);
      blocks.push({ kind: 'reviews', cardIds: due.slice(0, count).map((c) => c.cardId), minutes });
      total += minutes;
    }
    if (count === 0) {
      const weakest = weakestTopic(input.topics);
      if (weakest !== null && T >= 5) {
        const minutes = Math.min(T, 10);
        blocks.push({ kind: 'quiz_weak', topicId: weakest, questionCount: 5, minutes });
        total += minutes;
      } else {
        blocks.push({ kind: 'done' });
      }
    }
    return { targetMinutes: T, totalMinutes: total, blocks, fallback: true };
  }

  const blocks: SessionBlock[] = [];
  let total = 0;
  const recapMin = (input.newCardsFirstSeen ?? []).length > 0 ? (T >= 20 ? 2 : 1) : 0;
  // T ≤ 10: reviews only (§12 rule 1).
  const reviewBudget = T <= 10 ? T : Math.floor(0.4 * T);
  const maxReviews = Math.min(due.length, Math.floor((reviewBudget * 60) / reviewSeconds));
  let remaining = T;
  if (maxReviews > 0) {
    const minutes = Math.min(Math.ceil((maxReviews * reviewSeconds) / 60), remaining);
    blocks.push({ kind: 'reviews', cardIds: due.slice(0, maxReviews).map((c) => c.cardId), minutes });
    remaining -= minutes;
    total += minutes;
  }
  if (T <= 10) return { targetMinutes: T, totalMinutes: total, blocks, fallback: false };

  remaining -= recapMin;
  for (const item of pending) {
    if (remaining <= 0) break;
    const fits = item.minutes <= remaining;
    if (!fits && remaining < MIN_BLOCK) break;
    const minutes = fits ? item.minutes : remaining;
    blocks.push({
      kind: 'plan_item',
      planItemId: item.id,
      unitType: item.unitType,
      topicId: item.topicId,
      minutes,
      truncated: !fits,
    });
    remaining -= minutes;
    total += minutes;
    if (item.unitType === 'learn' || item.unitType === 'learn_light') {
      const questions = minutes <= 15 ? 3 : minutes <= 25 ? 4 : 5;
      const cost = Math.min(questions, Math.max(0, remaining));
      if (cost >= 3) {
        blocks.push({ kind: 'retrieval', topicId: item.topicId, questionCount: cost, minutes: cost });
        remaining -= cost;
        total += cost;
      }
    }
    if (!fits) break;
  }
  if (recapMin > 0) {
    const cards = (input.newCardsFirstSeen ?? []).slice();
    blocks.push({ kind: 'recap', cardIds: cards, minutes: recapMin });
    total += recapMin;
  }
  return { targetMinutes: T, totalMinutes: total, blocks, fallback: false };
}

/** Lowest mastery among studied topics; unknown mastery counts as 0.5 (§5.4 default for selection); ties → map order. */
function weakestTopic(topics: SessionInput['topics']): string | null {
  const studied = topics.filter((t) => t.studied);
  if (studied.length === 0) return null;
  const sorted = studied
    .slice()
    .sort((a, b) => (a.mastery ?? 0.5) - (b.mastery ?? 0.5) || a.order - b.order || (a.id < b.id ? -1 : 1));
  return sorted[0]?.id ?? null;
}
