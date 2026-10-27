// Feed de Estudos ranking and interleaving (learning-engine §10; FED-01, spec 06 §8.2–8.3).
import { FEED, MASTERY_DEFAULTS } from './params.ts';
import { unitHash } from './rng.ts';
import type { LocalDate } from './types.ts';
import { clamp } from './util.ts';

export type FeedPoolKey = 'D' | 'M' | 'Q' | 'G' | 'L' | 'K';

/**
 * D due cards (incl. exam boost) · M Caderno retries due · Q quick questions ·
 * G diagrams · L micro-lessons · K você-sabia.
 */
export interface FeedItem {
  id: string;
  pool: FeedPoolKey;
  subjectId: string;
  conceptId: string | null;
  /** examUrgency(concept) (§6.2). 0 when no exam. */
  examUrgency: number;
  /** m_i = masteryAt(concept); null → 0.5 (§5.4). */
  mastery: number | null;
  /** D items: effective due instant. */
  effectiveDue?: Date | null;
  /** D items: FSRS stability in days (duePressure denominator). */
  stabilityDays?: number;
  /** D items: moved earlier by the exam overlay. */
  examBoosted?: boolean;
  /** Seen before (novelty = 0). */
  seenBefore: boolean;
  /** Shown in the last 24 hours (recency penalty). */
  shownWithin24h: boolean;
  /** FED-01.9: a deliberate re-show, exempt from the 24-hour penalty. */
  reShow?: boolean;
}

export interface FeedContext {
  userId: string;
  /** Study day, for the jitter seed. */
  studyDay: LocalDate;
  /** Current instant, for duePressure. */
  now: Date;
  /** newCardQuota remaining for micro-lessons (FED-01.10). L items are skipped at 0. */
  newQuotaRemaining: number;
  /** Subjects in scope. The consecutive-subject rule applies at 2 or more. */
  subjectCount: number;
  /** Rounds to build. */
  rounds: number;
}

export type FeedPools = Readonly<Record<FeedPoolKey, readonly FeedItem[]>>;

export interface FeedRound {
  index: number;
  slots: Array<{ slot: 1 | 2 | 3 | 4 | 5; item: FeedItem; priority: number }>;
  retrievalCount: number;
}

const DAY_MS = 86_400_000;
const RETRIEVAL: readonly FeedPoolKey[] = ['D', 'M', 'Q'];

/** Round template (§10): each slot is a list of tiers; a tier pools several pools, and the first non-empty tier wins. */
const TEMPLATE: ReadonlyArray<ReadonlyArray<readonly FeedPoolKey[]>> = [
  [['L', 'G'], ['K']],
  [['D'], ['M'], ['Q']],
  [['Q'], ['D']],
  [['D'], ['M'], ['Q']],
  [['M'], ['K'], ['Q'], ['D']],
];

/** duePressure (§10): D items get clamp((now − due)/max(1 day, stability)) + 0.5·[exam-boosted]; M items 1; others 0. */
export function duePressure(item: FeedItem, now: Date): number {
  if (item.pool === 'M') return 1;
  if (item.pool !== 'D' || !item.effectiveDue) return 0;
  const stabilityMs = Math.max(DAY_MS, (item.stabilityDays ?? 0) * DAY_MS);
  const overdue = (now.getTime() - item.effectiveDue.getTime()) / stabilityMs;
  return clamp(overdue, 0, 1) + (item.examBoosted ? 0.5 : 0);
}

/**
 * priority_i = 0.4·examUrgency + 0.3·(1 − m) + 0.2·duePressure + 0.1·novelty − recencyPenalty + jitter (§10).
 * recencyPenalty is 1 when shown in the last 24 h (unless re-shown), else 0.5 when the same concept
 * is among the last three items; the larger applies. Jitter ∈ [−0.05, 0.05] from (user, study day, item).
 */
export function feedPriority(item: FeedItem, ctx: FeedContext, recentConcepts: readonly (string | null)[]): number {
  const m = item.mastery ?? MASTERY_DEFAULTS.feed;
  const novelty = item.seenBefore ? 0 : 1;
  let recency = 0;
  if (item.shownWithin24h && !item.reShow) recency = 1;
  else if (item.conceptId !== null && recentConcepts.includes(item.conceptId)) recency = 0.5;
  const jitter = (unitHash(ctx.userId, ctx.studyDay, item.id) * 2 - 1) * FEED.jitter;
  return (
    0.4 * item.examUrgency +
    0.3 * (1 - m) +
    0.2 * duePressure(item, ctx.now) +
    0.1 * novelty -
    recency +
    jitter
  );
}

/**
 * Builds `ctx.rounds` rounds of five items (§10). Each slot takes the best-ranked item of the first
 * non-empty tier. Items are not repeated across rounds. Constraints: no third consecutive item of the
 * same subject (when two or more subjects are in scope), L items only while the new-card quota allows,
 * and slot 3 prefers a question on the same concept as slot 1.
 */
export function rankFeed(pools: FeedPools, ctx: FeedContext): FeedRound[] {
  const remaining: Record<FeedPoolKey, FeedItem[]> = {
    D: [...(pools.D ?? [])],
    M: [...(pools.M ?? [])],
    Q: [...(pools.Q ?? [])],
    G: [...(pools.G ?? [])],
    L: [...(pools.L ?? [])],
    K: [...(pools.K ?? [])],
  };
  const history: FeedItem[] = [];
  let quota = ctx.newQuotaRemaining;
  const rounds: FeedRound[] = [];

  const wouldBreakSubjectRule = (item: FeedItem, extra: readonly FeedItem[]): boolean => {
    if (ctx.subjectCount < 2) return false;
    const tail = [...history, ...extra].slice(-2);
    return tail.length === 2 && tail.every((i) => i.subjectId === item.subjectId);
  };

  for (let r = 0; r < ctx.rounds; r++) {
    const roundItems: FeedItem[] = [];
    const slots: FeedRound['slots'] = [];
    for (let s = 0; s < TEMPLATE.length; s++) {
      const tiers = TEMPLATE[s] ?? [];
      const slotNo = (s + 1) as 1 | 2 | 3 | 4 | 5;
      const sameConceptAsSlot1 = s === 2 ? slots[0]?.item.conceptId ?? null : null;
      const picked = pickForSlot(tiers, remaining, quota, {
        ctx,
        recentItems: [...history, ...roundItems],
        preferConcept: sameConceptAsSlot1,
        subjectRule: (item) => wouldBreakSubjectRule(item, roundItems),
      });
      if (!picked) continue;
      const { item, priority } = picked;
      removeItem(remaining, item);
      if (item.pool === 'L') quota -= 1;
      roundItems.push(item);
      slots.push({ slot: slotNo, item, priority });
    }
    if (slots.length === 0) break;
    history.push(...roundItems);
    rounds.push({
      index: r,
      slots,
      retrievalCount: roundItems.filter((i) => RETRIEVAL.includes(i.pool)).length,
    });
  }
  return rounds;
}

function removeItem(remaining: Record<FeedPoolKey, FeedItem[]>, item: FeedItem): void {
  const list = remaining[item.pool];
  if (!list) return;
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

function pickForSlot(
  tiers: ReadonlyArray<readonly FeedPoolKey[]>,
  remaining: Record<FeedPoolKey, FeedItem[]>,
  quota: number,
  opts: {
    ctx: FeedContext;
    /** Items already placed (earlier rounds and this round); the last three drive the recency penalty. */
    recentItems: readonly FeedItem[];
    preferConcept: string | null;
    subjectRule: (item: FeedItem) => boolean;
  },
): { item: FeedItem; priority: number } | null {
  const available = (pool: FeedPoolKey): FeedItem[] => (pool === 'L' && quota <= 0 ? [] : remaining[pool] ?? []);
  const recent = opts.recentItems.slice(-FEED.recentWindow).map((i) => i.conceptId);

  // Two passes per tier: first respect the subject rule, then relax it so a slot is never left empty.
  for (const relax of [false, true]) {
    for (const tier of tiers) {
      const candidates: Array<{ item: FeedItem; priority: number }> = [];
      for (const pool of tier) {
        for (const item of available(pool)) {
          if (!relax && opts.subjectRule(item)) continue;
          candidates.push({ item, priority: feedPriority(item, opts.ctx, recent) });
        }
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        if (opts.preferConcept !== null) {
          const pa = a.item.conceptId === opts.preferConcept ? 1 : 0;
          const pb = b.item.conceptId === opts.preferConcept ? 1 : 0;
          if (pa !== pb) return pb - pa;
        }
        return b.priority - a.priority || a.item.id.localeCompare(b.item.id);
      });
      const best = candidates[0];
      if (best) return best;
    }
  }
  return null;
}
