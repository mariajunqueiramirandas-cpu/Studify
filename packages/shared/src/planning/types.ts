// Planner data contracts (GOL-04, learning-engine §11). Plain data in, plain data out:
// callers load rows, the planner never touches storage or the clock.

/** Local study day, 'YYYY-MM-DD' (rollover at 04:00, learning-engine §0.2). */
export type PlanDay = string;

/** Unit kinds, matching the database enum `plan_items.unit_type`. The second practice of a topic is `practice` with a `practice2:` unit key. */
export type PlanUnitKind = 'learn' | 'learn_light' | 'practice' | 'mock' | 'vespera' | 'upload_material' | 'warmup';

/** `plan_items.status` values from the database enum. */
export type PlanItemState = 'planned' | 'done' | 'skipped';

/** Replan triggers (spec 07 §8.2.6). */
export type ReplanTrigger =
  | 'nightly'
  | 'exam_changed'
  | 'scope_changed'
  | 'grade_logged'
  | 'mastery_shift'
  | 'material_ready'
  | 'availability_changed'
  | 'manual_edit';

export type MaterialKind = 'slides' | 'notes' | 'textbook' | 'other';

export type AttackGroup = 'focus' | 'basic' | 'out';

export interface PlanExam {
  id: string;
  subjectId: string;
  title: string;
  /** Local date of the test, D_e (authoritative). */
  localDate: PlanDay;
  status: 'draft' | 'scheduled' | 'done' | 'cancelled';
  /** Weight W_e (> 0). */
  weight: number;
  /** Scope topics N_e (concepts already rolled up to topics). */
  scopeTopicIds: string[];
  /** Optional raw topic weights ω (Prova Provável, spec 08). Normalized over N_e; default ∝ learn minutes. */
  topicWeights?: Record<string, number> | null;
  /** ρ_e = required grade / scale_max (GOL-06). null → 0.5 (no grading rules). */
  requiredRatio?: number | null;
}

export interface PlanTopic {
  id: string;
  subjectId: string;
  /** Knowledge-map order (unit → topic). Ties are broken by this, then by id. */
  order: number;
  /** Source pages used for est_learn_minutes (learning-engine §11.1). */
  sources: Array<{ kind: MaterialKind; pages: number }>;
  /** Placeholder topic from GOL-03.4: only upload_material work, no learn/practice. */
  isPlaceholder?: boolean;
  /** cov_n: the topic has been studied (learn done, ≥ 5 card reviews or ≥ 3 questions). */
  studied: boolean;
  /** m_n in [0, 1]. null is treated as 0 by the planner (learning-engine §5.4). */
  mastery: number | null;
  /** PRA-05 overconfidence: priority × 1.15. */
  overconfident?: boolean;
}

export interface PlanAvailability {
  /** A(d) base minutes, Monday first (study_preferences.minutes_by_weekday). */
  minutesByWeekday: number[];
  /** Date exceptions (availability_exceptions). 0 = blocked. */
  exceptions?: Record<PlanDay, number>;
}

export interface PlanSettings {
  /** Block limits (learning-engine L11 defaults). Desperate mode uses 25 min blocks. */
  maxBlockMin: number;
  minBlockMin: number;
  maxSubjectsPerDay: number;
  /** Layout window for start/end minutes. End defaults to quiet hours (22:00). */
  windowStartMin: number;
  windowEndMin: number;
  /** κ, pace factor (learning-engine §11.1). */
  pace: number;
  /** Test days keep this share of capacity (D-46 default 0.5). */
  testDayFactor: number;
  /** Reviews may use at most this share of A(d) (§11.3). */
  reviewCapFactor: number;
}

export interface PlanPreviousItem {
  /** Block id from the last run (`unitKey` or `unitKey#n`). */
  id: string;
  unitKey: string;
  unitType: PlanUnitKind;
  examIds: string[];
  topicId: string | null;
  day: PlanDay;
  minutes: number;
  status: PlanItemState;
  pinned: boolean;
  priority?: number;
  deadline?: PlanDay;
}

export interface DesperateOptions {
  /** "Quanto tempo você tem por dia?" (GOL-12.4), capped at 240. */
  minutesPerDay: number;
  /** Tests inside the 7-day window (GOL-12.2). */
  coveredExamIds: string[];
  /** Precomputed groups. Omit to let buildPlan run the plano de ataque (§8.10.2). */
  groups?: Record<string, AttackGroup>;
  /** Topics the student moved by hand; they keep their group on recompute. */
  userMoves?: Record<string, AttackGroup>;
}

export interface PlanInput {
  today: PlanDay;
  /** Carried for callers and the run hash; the planner works on local dates only. */
  timeZone: string;
  exams: PlanExam[];
  topics: PlanTopic[];
  availability: PlanAvailability;
  /** R_raw(d) in minutes from forecastReviewLoad (§3.4). */
  reviewForecast?: Record<PlanDay, number>;
  /** Existing plan items: done/pinned items never move; the rest are movable per trigger. */
  previous?: PlanPreviousItem[];
  /** For trigger `manual_edit`: the day the student edited. */
  editedDay?: PlanDay;
  /** For triggers other than exam/nightly: whether a session already started today (§8.2.6). */
  sessionStartedToday?: boolean;
  mode?: 'normal' | 'desperate';
  desperate?: DesperateOptions;
  settings?: Partial<PlanSettings>;
}

export interface PlanItem {
  id: string;
  unitKey: string;
  unitType: PlanUnitKind;
  examIds: string[];
  topicId: string | null;
  day: PlanDay;
  minutes: number;
  deadline: PlanDay;
  priority: number;
  orderInDay: number;
  demanding: boolean;
  pinned: boolean;
  status: PlanItemState;
  /** Layout inside the day window (minutes from midnight). Reviews are reserved first. */
  startMin: number;
  endMin: number;
  /** GOL-04.6 template key and parameters (no AI). */
  reason: { key: string; params: Record<string, string | number> };
}

export interface PlanDayLoad {
  day: PlanDay;
  availableMin: number;
  reviewMin: number;
  /** Minutes left for units after reviews, test-day halving and fixed items. */
  capacityMin: number;
  plannedMin: number;
}

export interface PlanTriageStep {
  step: 'drop_practice2' | 'downgrade_learn' | 'shorten_mock' | 'drop_learn_light';
  unitKey: string;
  topicId: string | null;
}

export interface PlanRun {
  trigger: ReplanTrigger;
  /** fnv1a32 of the canonical input (plan_runs.input_hash). */
  inputHash: string;
  items: PlanItem[];
  days: PlanDayLoad[];
  feasible: boolean;
  triage: PlanTriageStep[];
  /** Block ids placed over capacity by at most 15 min (step 5b). */
  tight: string[];
  /** Unit keys left "fora do plano" (still accessible). */
  outOfPlan: string[];
  /** Unit keys of unstarted past items returned to the pool by a nightly run. */
  skipped: string[];
  /** Days where the review forecast exceeds 60% of availability (plan.review_overflow). */
  reviewOverflow: PlanDay[];
  excludedExams: Array<{ examId: string; reason: 'too_close' | 'not_scheduled' }>;
  /** Minutes of items that changed day against `previous`. */
  movedMinutes: number;
  /** "Reorganizei seu plano" only when ≥ 15 minutes changed day (GOL-04.5). */
  reorganized: boolean;
  attack?: { groups: Record<string, AttackGroup>; coverage: Record<string, number> };
}
