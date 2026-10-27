// FSRS wrapper over ts-fsrs (MEM-02, learning-engine §2, ADR 0004 / 0007).
// Scheduling is pure: the caller supplies `now`, the params and the prior state.
import {
  State as LibState,
  StrategyMode,
  fsrs as createScheduler,
  generatorParameters,
  type Card as LibCard,
  type FSRS,
  type Grade,
  type StepUnit,
  type TSeedStrategy,
} from 'ts-fsrs';
import { CLOCK_SKEW_MS, CROSS_DEVICE_WINDOW_MS, BACKLOG, LEECH } from './params.ts';
import type {
  CardKind,
  CardState,
  LearningParams,
  RatingPreview,
  RecoveryPlan,
  Rating,
  ReviewLog,
  ReviewLogDraft,
} from './types.ts';
import { compareStrings } from './util.ts';

// ---------- ts-fsrs bridge ----------

const KIND_TO_LIB: Readonly<Record<CardKind, LibState>> = {
  new: LibState.New,
  learning: LibState.Learning,
  review: LibState.Review,
  relearning: LibState.Relearning,
};

const LIB_TO_KIND: Readonly<Record<LibState, CardKind>> = {
  [LibState.New]: 'new',
  [LibState.Learning]: 'learning',
  [LibState.Review]: 'review',
  [LibState.Relearning]: 'relearning',
};

/**
 * Fuzz seed (§2.1): the card id plus the repetition count. ts-fsrs passes the scheduler as `this`,
 * and its `current` card carries `cardId` through TypeConvert's spread, so no clock is involved.
 */
const seedFromCard = function (this: { current: { cardId?: unknown; reps: number } }): string {
  return `${String(this.current.cardId ?? '')}|${this.current.reps}`;
};

const schedulerCache = new WeakMap<LearningParams, FSRS>();

function schedulerFor(params: LearningParams): FSRS {
  const cached = schedulerCache.get(params);
  if (cached) return cached;
  const scheduler = createScheduler(
    generatorParameters({
      request_retention: params.requestRetention,
      maximum_interval: params.maximumInterval,
      w: [...params.weights],
      enable_fuzz: params.enableFuzz,
      enable_short_term: params.enableShortTerm,
      learning_steps: [...params.learningSteps] as StepUnit[],
      relearning_steps: [...params.relearningSteps] as StepUnit[],
    }),
  ).useStrategy(StrategyMode.SEED, seedFromCard as unknown as TSeedStrategy);
  schedulerCache.set(params, scheduler);
  return scheduler;
}

function toLib(state: CardState): LibCard & { cardId: string } {
  return {
    cardId: state.cardId,
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: 0,
    scheduled_days: state.scheduledDays,
    learning_steps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: KIND_TO_LIB[state.state],
    last_review: state.lastReview ?? undefined,
  };
}

function fromLib(card: LibCard, prev: CardState): CardState {
  return {
    cardId: prev.cardId,
    state: LIB_TO_KIND[card.state],
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    lastReview: card.last_review ?? null,
    suspended: prev.suspended,
  };
}

// ---------- state ----------

/** A card that has never been reviewed. `createdAt` is its initial due instant. */
export function newCardState(cardId: string, createdAt: Date): CardState {
  return {
    cardId,
    state: 'new',
    due: createdAt,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    scheduledDays: 0,
    learningSteps: 0,
    lastReview: null,
    suspended: false,
  };
}

/** A card is introduced once it has a review (learn step or later). Used by queue, mastery and the map. */
export function isIntroduced(state: CardState): boolean {
  return state.state !== 'new' || state.reps > 0;
}

// ---------- scheduling ----------

/**
 * Schedule one rating at instant `at` (MEM-02.1). Reviews earlier than the last review are
 * clamped to it, so a local clock running behind cannot reorder history.
 */
export function scheduleReview(
  state: CardState,
  rating: Rating,
  at: Date,
  params: LearningParams,
): { next: CardState; log: ReviewLogDraft } {
  const reviewAt = state.lastReview && at.getTime() < state.lastReview.getTime() ? state.lastReview : at;
  const record = schedulerFor(params).next(toLib(state), reviewAt, rating as Grade);
  return {
    next: fromLib(record.card, state),
    log: { cardId: state.cardId, rating, reviewedAt: at },
  };
}

/**
 * The four button previews for a card (MEM-02.2, "Bom, próxima revisão em 3 dias").
 * The previews come from the same scheduler call as `scheduleReview`, so they match exactly.
 */
export function previewRatings(state: CardState, at: Date, params: LearningParams): RatingPreview[] {
  const scheduler = schedulerFor(params);
  const preview = scheduler.repeat(toLib(state), at);
  const out: RatingPreview[] = [];
  for (const rating of [1, 2, 3, 4] as const) {
    const item = preview[rating as Grade];
    const intervalMs = item.card.due.getTime() - at.getTime();
    out.push({
      rating,
      label: formatIntervalPt(intervalMs),
      intervalMs,
      due: item.card.due,
      next: fromLib(item.card, state),
    });
  }
  return out;
}

/** PT-BR interval label used on the rating buttons (MEM-02.2). */
export function formatIntervalPt(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? '1 dia' : `${days} dias`;
  if (days < 60) return `${Math.round(days / 7)} sem.`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return months === 1 ? '1 mês' : `${months} meses`;
  }
  const years = Math.round(days / 365);
  return years === 1 ? '1 ano' : `${years} anos`;
}

/**
 * Retrievability R(t) from ts-fsrs (§5.1, §16.1). `null` for cards that were never introduced.
 * Suspended cards are not excluded here: callers filter them.
 */
export function retrievability(state: CardState, at: Date, params: LearningParams): number | null {
  if (!isIntroduced(state) || !state.lastReview) return null;
  return schedulerFor(params).get_retrievability(toLib(state), at, false);
}

// ---------- leeches (§2.3) ----------

/** `is_leech = lapses ≥ 6` (MEM-02.12). */
export function isLeech(state: CardState): boolean {
  return state.lapses >= LEECH.threshold;
}

/**
 * Whether a lapse that brings the card to `lapsesAfter` shows the leech prompt.
 * Prompted at 6, 9, 12, … (every 3 lapses after the threshold). Never auto-suspends.
 */
export function leechPromptOnLapse(lapsesAfter: number): boolean {
  return lapsesAfter >= LEECH.threshold && (lapsesAfter - LEECH.threshold) % LEECH.repromptEvery === 0;
}

// ---------- backlog recovery (§2.4) ----------

/**
 * Modo recuperação (MEM-02.16). When due reviews exceed 3 × the daily maximum, the backlog is
 * spread over up to 7 days: `dailyCap = ceil(due / min(7, ceil(due / max)))`.
 */
export function backlogRecovery(dueCount: number, maxReviewsPerDay: number): RecoveryPlan {
  if (dueCount <= BACKLOG.multiple * maxReviewsPerDay) {
    return { offered: false, days: 0, dailyCap: maxReviewsPerDay };
  }
  const days = Math.min(BACKLOG.maxDays, Math.ceil(dueCount / maxReviewsPerDay));
  return { offered: true, days, dailyCap: Math.ceil(dueCount / days) };
}

// ---------- offline replay and merge (§2.6, ADR 0007) ----------

/** Drops every undo log and the log it cancels (MEM-02.8). Undo pairs leave no trace in replay. */
export function dropUndonePairs(logs: readonly ReviewLog[]): ReviewLog[] {
  const undone = new Set<string>();
  for (const log of logs) {
    if (log.undoesLogId) undone.add(log.undoesLogId);
  }
  return logs.filter((log) => !log.undoesLogId && !undone.has(log.id));
}

/**
 * Clock sanity (§0.2, ADR 0007 point 6): a device timestamp more than 5 min ahead of server
 * receipt is replayed at receipt time instead.
 */
export function clampFutureTimestamp(log: ReviewLog): ReviewLog {
  if (!log.receivedAt) return log;
  if (log.reviewedAt.getTime() - log.receivedAt.getTime() <= CLOCK_SKEW_MS) return log;
  return { ...log, reviewedAt: log.receivedAt };
}

/** Total order for replay: reviewed_at, then id (§2.6). */
export function compareReviewLogs(a: ReviewLog, b: ReviewLog): number {
  return a.reviewedAt.getTime() - b.reviewedAt.getTime() || compareStrings(a.id, b.id);
}

/**
 * Same card reviewed on two devices within 60 s: the later one is ignored (§2.6, spec 04 §8.8).
 * Same-device logs are never deduplicated (quick Errei → Bom sequences are legitimate).
 * Expects logs already sorted by `compareReviewLogs`.
 */
export function dropCrossDeviceDoubles(sorted: readonly ReviewLog[], windowMs: number = CROSS_DEVICE_WINDOW_MS): ReviewLog[] {
  const lastKept = new Map<string, ReviewLog>();
  const out: ReviewLog[] = [];
  for (const log of sorted) {
    const prev = lastKept.get(log.cardId);
    if (prev && prev.deviceId !== log.deviceId && log.reviewedAt.getTime() - prev.reviewedAt.getTime() < windowMs) {
      continue;
    }
    out.push(log);
    lastKept.set(log.cardId, log);
  }
  return out;
}

/** The canonical log sequence that replay folds over: undo pairs out, clamped, sorted, deduplicated. */
export function canonicalReviewLogs(logs: readonly ReviewLog[]): ReviewLog[] {
  const sorted = dropUndonePairs(logs).map(clampFutureTimestamp).sort(compareReviewLogs);
  return dropCrossDeviceDoubles(sorted);
}

/**
 * Authoritative state of one card, replayed from its full log history (§2.6). Equal inputs give
 * equal outputs regardless of the order the logs arrived in.
 */
export function replayCard(
  cardId: string,
  logs: readonly ReviewLog[],
  params: LearningParams,
  createdAt: Date = new Date(0),
): CardState {
  const own = logs.filter((log) => log.cardId === cardId);
  let state = newCardState(cardId, createdAt);
  for (const log of canonicalReviewLogs(own)) {
    state = scheduleReview(state, log.rating, log.reviewedAt, params).next;
  }
  return state;
}

/** Replays every card in a log set. Output keys are card ids. */
export function replayReviewLogs(
  logs: readonly ReviewLog[],
  params: LearningParams,
  createdAt: Date = new Date(0),
): Map<string, CardState> {
  const ids = [...new Set(logs.map((log) => log.cardId))].sort(compareStrings);
  const out = new Map<string, CardState>();
  for (const id of ids) out.set(id, replayCard(id, logs, params, createdAt));
  return out;
}
