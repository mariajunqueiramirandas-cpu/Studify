// Contracts for the learning engine (docs/engineering/learning-engine.md §1).
// Pure data only: no I/O, no framework types. Instants are `Date` values;
// `LocalDate` is 'YYYY-MM-DD' on the user's study-day calendar (§0.2).

export type LocalDate = string;

/** 1 Errei (Again) · 2 Difícil (Hard) · 3 Bom (Good) · 4 Fácil (Easy) — MEM-02.2 */
export type Rating = 1 | 2 | 3 | 4;
export type CardKind = 'new' | 'learning' | 'review' | 'relearning';

/**
 * Learning settings and FSRS configuration. Defaults live in `DEFAULT_LEARNING_PARAMS`
 * (params.ts). Overrides come from `profiles.settings` on the server, never silently on device.
 */
export interface LearningParams {
  /** r_target, "Meta de lembrança" (MEM-02.3). Range 0.80–0.95. */
  requestRetention: number;
  /** r_exam, the retrievability an exam overlay aims for. Defaults to requestRetention. */
  rExam: number;
  /** Maximum interval in days (MEM-02.3). */
  maximumInterval: number;
  /** max reviews per study day (MEM-02.3). */
  maxReviewsPerDay: number;
  /** New cards per day when there is no active plan (MEM-02.3). */
  newPerDayNoPlan: number;
  /** ts-fsrs fuzz, seeded per (card id, reps) so replays are deterministic. */
  enableFuzz: boolean;
  enableShortTerm: boolean;
  learningSteps: readonly string[];
  relearningSteps: readonly string[];
  /** FSRS weights (ts-fsrs default_w until personal optimisation, §2.5). */
  weights: readonly number[];
  /** Fallback seconds per review for time estimates (§3.4). */
  reviewSecondsDefault: number;
  /** IANA time zone for study days (§0.2). */
  timeZone: string;
}

/**
 * Card state with the FSRS memory fields, the card id (used as the fuzz seed) and the
 * app-level flags. Maps 1:1 to a ts-fsrs `Card` plus `cardId`, `suspended`.
 */
export interface CardState {
  cardId: string;
  state: CardKind;
  /** FSRS due instant (`fsrs_due`, before the exam overlay). */
  due: Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningSteps: number;
  lastReview: Date | null;
  suspended: boolean;
}

/** One append-only row of `review_logs` (ADR 0007). */
export interface ReviewLog {
  /** Client-generated UUID v7. Also the deterministic tie-breaker for replay. */
  id: string;
  cardId: string;
  rating: Rating;
  reviewedAt: Date;
  deviceId: string;
  /** Server receipt time, when known. Used for the clock-skew clamp (§0.2). */
  receivedAt?: Date | null;
  /** Set on an undo log: the id of the log this undo cancels (MEM-02.8). */
  undoesLogId?: string | null;
  source?: 'session' | 'feed' | 'widget' | 'notification' | 'map' | 'vespera';
  reason?: 'due' | 'exam_boost' | 'early' | 'learning';
  durationMs?: number | null;
}

export interface ReviewLogDraft {
  cardId: string;
  rating: Rating;
  reviewedAt: Date;
}

export interface RatingPreview {
  rating: Rating;
  /** PT-BR interval label for the button: "<1 min", "10 min", "3 dias", "2 sem.". */
  label: string;
  intervalMs: number;
  due: Date;
  next: CardState;
}

export interface RecoveryPlan {
  /** True when due reviews exceed 3 × the daily maximum (MEM-02.16). */
  offered: boolean;
  /** Days to spread the backlog over (≤ 7). 0 when not offered. */
  days: number;
  /** Daily cap while in recovery mode. */
  dailyCap: number;
}

/** A scheduled exam and the cards in its scope, as loaded by the caller. */
export interface ExamScope {
  examId: string;
  status: 'scheduled' | 'done' | 'cancelled';
  /** starts_at, or local_date at 07:00 when no time is set. */
  startsAt: Date;
  localDate: LocalDate;
  weight: number;
  /** weight / max weight among the goal's scheduled exams, (0, 1]. See normalizeExamWeights. */
  weightNorm: number;
  /** Scope nodes including descendants (concepts). */
  nodeIds: readonly string[];
}

export type EvidenceQuestionType =
  | 'true_false'
  | 'mcq_single'
  | 'fill_blank'
  | 'numeric'
  | 'matching'
  | 'ordering'
  | 'multi_select'
  | 'short_answer'
  | 'find_error'
  | 'essay_question'
  | 'problem';

/** Evidence sources from learning-engine §5.2 (source multiplier table). */
export type EvidenceSource =
  | 'quiz'
  | 'simulado'
  | 'caderno_retry'
  | 'session_check'
  | 'feed_quick'
  | 'tutor_quiz'
  | 'duel'
  | 'battle'
  | 'lucas'
  | 'camera'
  | 'self_override'
  | 'diagnostic';

export type Confidence = 1 | 2 | 3 | 4;

/** One question-type evidence event for a concept (§5.1–5.2). Card reviews are not evidence events. */
export interface EvidenceEvent {
  /** Idempotency key: recording the same id twice is a no-op. */
  id: string;
  /** Leaf node (concept) the answer is evidence for. */
  conceptId: string;
  answeredAt: Date;
  questionType: EvidenceQuestionType;
  source: EvidenceSource;
  /** Evidence score s in [0, 1]: 1 correct, 0 wrong, partial credit in between. */
  score: number;
  confidence?: Confidence | null;
  /** problem: hints used before answering (PRA-08.3). */
  hintsUsed?: number;
  /** problem: true when the full solution was viewed. camera: true when the assisted solution was shown. */
  solutionViewed?: boolean;
}

/** Decayed sums for one node (§5.3). Reference time is `updatedAt`. */
export interface EvidenceAggregate {
  sumW: number;
  sumWS: number;
  /** Raw count of question-type evidence events. */
  count: number;
  updatedAt: Date | null;
}

export type MasteryRetrievabilitySource = 'cards' | 'questions';

export interface MasteryResult {
  mastery: number | null;
  retrievability: number | null;
  retrievabilitySource: MasteryRetrievabilitySource | null;
  /** Card reviews (Σ reps of introduced cards) + question evidence events. */
  evidenceCount: number;
  studied: boolean;
  /** Beta-posterior accuracy acc_n(t). 0.5 with no question evidence. */
  accuracy: number;
}

/** Output of a study-day sized review queue entry. */
export interface QueueEntry {
  cardId: string;
  kind: 'learning' | 'review' | 'new';
  /** Effective due instant (min of FSRS due and exam overlay); for new cards, the card's due. */
  due: Date;
  reason: 'learning' | 'due' | 'exam_boost' | 'new';
  /** Exam that moved the card earlier, if any. */
  examId: string | null;
  retrievability: number | null;
}

export interface ForecastDay {
  date: LocalDate;
  dueCount: number;
  examBoostCount: number;
  estMinutes: number;
}
