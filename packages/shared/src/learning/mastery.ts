// Mastery (learning-engine §5; spec 05 §8.6, spec 07 §8.6). Evidence sums are decayed with a
// 7-day half-life and stored relative to a reference time, so incremental updates equal the batch.
import { MASTERY, MASTERY_DEFAULTS } from './params.ts';
import { isIntroduced, retrievability } from './fsrs.ts';
import type {
  CardState,
  EvidenceAggregate,
  EvidenceEvent,
  EvidenceQuestionType,
  EvidenceSource,
  LearningParams,
  MasteryResult,
} from './types.ts';
import { compareStrings, mean } from './util.ts';

const DAY_MS = 86_400_000;

// ---------- evidence weights (§5.2) ----------

const TYPE_WEIGHT: Readonly<Record<EvidenceQuestionType, number>> = {
  true_false: 0.5,
  mcq_single: 1.0,
  fill_blank: 1.0,
  numeric: 1.0,
  matching: 1.0,
  ordering: 1.0,
  multi_select: 1.2,
  short_answer: 1.5,
  find_error: 1.5,
  essay_question: 2.0,
  problem: 2.0,
};

const SOURCE_MULTIPLIER: Readonly<Record<EvidenceSource, number>> = {
  quiz: 1.0,
  simulado: 1.0,
  caderno_retry: 1.0,
  session_check: 1.0,
  feed_quick: 1.0,
  tutor_quiz: 0.5,
  duel: 0.75,
  battle: 0.75,
  lucas: 0.75,
  camera: 1.0,
  self_override: 0.5,
  diagnostic: 1.0,
};

/** Hint credit for `problem` items (PRA-08.3): 0 / 1 / 2 / 3 hints, then solution viewed. */
const HINT_CREDIT = [1.0, 0.75, 0.5, 0.25] as const;

/**
 * w_e = type_weight × source_multiplier × confidence_multiplier (§5.2), with the special cases:
 *  - problem: 2.0 × hint credit (0 once the solution is viewed);
 *  - camera (assisted solution, CAM-02.10): a positive result with the solution viewed carries no
 *    weight; a wrong attempt is negative evidence with weight 1.0.
 */
export function evidenceWeight(ev: EvidenceEvent): number {
  const correct = ev.score >= 1;

  if (ev.source === 'camera') {
    if (ev.solutionViewed && ev.score > 0) return 0;
    if (ev.score <= 0) return 1.0;
  }

  let typeWeight = TYPE_WEIGHT[ev.questionType];
  if (ev.questionType === 'problem') {
    typeWeight = ev.solutionViewed ? 0 : TYPE_WEIGHT.problem * (HINT_CREDIT[Math.min(ev.hintsUsed ?? 0, 3)] ?? 0);
  }

  let confidence = 1.0;
  if (correct && ev.confidence === 4) confidence = 1.2;
  else if (correct && ev.confidence === 1) confidence = 0.5;

  return typeWeight * SOURCE_MULTIPLIER[ev.source] * confidence;
}

// ---------- decay and incremental update (§5.1, §5.3) ----------

/** decay_7(Δ) = 0.5^(Δ_days / 7). Negative Δ (the event is older than the reference) gives a factor above 1. */
export function decayFactor(deltaMs: number): number {
  return Math.pow(0.5, deltaMs / DAY_MS / MASTERY.halfLifeDays);
}

export function emptyAggregate(): EvidenceAggregate {
  return { sumW: 0, sumWS: 0, count: 0, updatedAt: null };
}

/**
 * Folds one evidence event into a node's aggregate (§5.3). Reference time is `updatedAt`:
 * newer events decay the stored sums forward; older events are decayed back to the reference.
 * Either way the result equals Σ w_e · decay(t − t_e) for every event, in any arrival order.
 */
export function foldEvidence(agg: EvidenceAggregate, ev: EvidenceEvent): EvidenceAggregate {
  const w = evidenceWeight(ev);
  const ws = w * ev.score;
  const t = ev.answeredAt.getTime();

  if (agg.updatedAt === null) {
    return { sumW: w, sumWS: ws, count: agg.count + 1, updatedAt: ev.answeredAt };
  }
  const ref = agg.updatedAt.getTime();
  if (t >= ref) {
    const k = decayFactor(t - ref);
    return { sumW: agg.sumW * k + w, sumWS: agg.sumWS * k + ws, count: agg.count + 1, updatedAt: ev.answeredAt };
  }
  const k = decayFactor(ref - t);
  return { sumW: agg.sumW + w * k, sumWS: agg.sumWS + ws * k, count: agg.count + 1, updatedAt: agg.updatedAt };
}

/** Decayed sums of an aggregate at instant `at`. */
export function decayedSums(agg: EvidenceAggregate, at: Date): { w: number; ws: number } {
  if (agg.updatedAt === null) return { w: 0, ws: 0 };
  const k = decayFactor(at.getTime() - agg.updatedAt.getTime());
  return { w: agg.sumW * k, ws: agg.sumWS * k };
}

/** Beta(1,1) posterior mean acc_n(t) = (1 + Σ d·w·s) / (2 + Σ d·w) (§5.1). */
export function accuracyAt(agg: EvidenceAggregate, at: Date): number {
  const { w, ws } = decayedSums(agg, at);
  return (1 + ws) / (2 + w);
}

/**
 * Immutable evidence ledger: per-node aggregates plus the seen event ids. `recordEvidence` is
 * idempotent on `ev.id` (§1), so re-delivered events from the outbox do nothing.
 */
export interface EvidenceLedger {
  readonly byNode: Readonly<Record<string, EvidenceAggregate>>;
  readonly seenIds: ReadonlySet<string>;
}

export function emptyLedger(): EvidenceLedger {
  return { byNode: {}, seenIds: new Set() };
}

/**
 * Records one event for the concept and each of its ancestors (the roll-up of §5.1).
 * `ancestors` is the list of parent node ids, nearest first, computed by the caller from the map.
 */
export function recordEvidence(ledger: EvidenceLedger, ev: EvidenceEvent, ancestors: readonly string[]): EvidenceLedger {
  if (ledger.seenIds.has(ev.id)) return ledger;
  const byNode: Record<string, EvidenceAggregate> = { ...ledger.byNode };
  for (const nodeId of [ev.conceptId, ...ancestors]) {
    byNode[nodeId] = foldEvidence(byNode[nodeId] ?? emptyAggregate(), ev);
  }
  const seenIds = new Set(ledger.seenIds);
  seenIds.add(ev.id);
  return { byNode, seenIds };
}

/** Ancestor ids (nearest first) from a child → parent map. Cycle-safe. */
export function ancestorsOf(nodeId: string, parentOf: Readonly<Record<string, string | null | undefined>>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([nodeId]);
  let current = parentOf[nodeId];
  while (current && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = parentOf[current];
  }
  return out;
}

/** Batch aggregate of an event list. Equal to folding the events one by one in any order. */
export function aggregateEvidence(events: readonly EvidenceEvent[]): EvidenceAggregate {
  const ordered = [...events].sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime() || compareStrings(a.id, b.id));
  return ordered.reduce(foldEvidence, emptyAggregate());
}

// ---------- mastery (§5.1) ----------

export interface MasteryInput {
  /** Question evidence aggregate of the node, already rolled up over its descendants. */
  agg: EvidenceAggregate | null;
  /** Cards pooled in the node and its descendants (suspended and never-introduced ones are fine; they are filtered). */
  cards: readonly CardState[];
  /** A learn unit of the node is done. */
  learnUnitDone?: boolean;
}

/**
 * Mastery at instant `t` for one node (§5.1):
 *   acc_n = (1 + Σ d·w·s) / (2 + Σ d·w)
 *   R̄_n   = mean FSRS retrievability of the introduced, non-suspended cards
 *   λ_n   = 0.5 with both card and question evidence, 1 with cards only, 0 with questions only
 *   mastery_n = λ·R̄ + (1 − λ)·acc, null when there is neither card nor question evidence.
 */
export function masteryAt(input: MasteryInput, t: Date, params: LearningParams): MasteryResult {
  const live = input.cards.filter((c) => !c.suspended && isIntroduced(c));
  const rValues: number[] = [];
  for (const card of live) {
    const r = retrievability(card, t, params);
    if (r !== null) rValues.push(r);
  }
  const rBar = mean(rValues);
  const questionCount = input.agg?.count ?? 0;
  const cardReviews = input.cards.reduce((sum, c) => sum + (isIntroduced(c) ? c.reps : 0), 0);

  const acc = input.agg ? accuracyAt(input.agg, t) : 0.5;

  let mastery: number | null = null;
  if (rBar !== null || questionCount > 0) {
    const hasCards = rBar !== null;
    const hasQuestions = questionCount > 0;
    const lambda = hasCards && hasQuestions ? MASTERY.lambdaBoth : hasCards ? 1 : 0;
    mastery = lambda * (rBar ?? 0) + (1 - lambda) * acc;
  }

  let retrievabilityValue: number | null = null;
  let source: MasteryResult['retrievabilitySource'] = null;
  const evidenceCount = cardReviews + questionCount;
  if (rBar !== null) {
    retrievabilityValue = rBar;
    source = 'cards';
  } else if (questionCount >= MASTERY.questionRetrievabilityMinEvidence) {
    retrievabilityValue = acc;
    source = 'questions';
  }

  const studied =
    input.learnUnitDone === true ||
    cardReviews >= MASTERY.studiedCardReviews ||
    questionCount >= MASTERY.studiedQuestions;

  return {
    mastery,
    retrievability: retrievabilityValue,
    retrievabilitySource: source,
    evidenceCount,
    studied,
    accuracy: acc,
  };
}

/** Consumer defaults for a null mastery (§5.4, L4). */
export function masteryOrDefault(mastery: number | null, consumer: keyof typeof MASTERY_DEFAULTS): number {
  return mastery ?? MASTERY_DEFAULTS[consumer];
}

/**
 * Mastery shift (§5.5): nodes whose value moved by at least 0.15 since the last plan run.
 * Only nodes with a value at both times are compared. Output keeps the in-scope order.
 */
export function detectMasteryShift(
  previous: Readonly<Record<string, number | null>>,
  current: Readonly<Record<string, number | null>>,
  inScope: readonly string[],
): string[] {
  return inScope.filter((id) => {
    const before = previous[id];
    const after = current[id];
    if (before === null || before === undefined || after === null || after === undefined) return false;
    return Math.abs(after - before) >= MASTERY.shiftThreshold;
  });
}
