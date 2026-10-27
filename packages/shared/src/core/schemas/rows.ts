import type { Citation, SourcePage } from '../citations.ts';
import type {
  AnswerKeySource,
  AppRole,
  AttemptStatus,
  BloomLevel,
  CardOrigin,
  CardStatus,
  CardType,
  CauseSource,
  ConfidenceLevel,
  ContentStatus,
  DifficultyBand,
  DisplayNameStatus,
  EnemArea,
  ExamKind,
  ExamScopeStatus,
  ExamStatus,
  FeedItemStatus,
  FeedItemType,
  ForeignLanguage,
  GoalMode,
  GoalStatus,
  GradingStatus,
  HiddenReason,
  HighlightColor,
  InputMode,
  MistakeCause,
  NodeKind,
  NoteDepth,
  NoteScopeKind,
  NoteStatus,
  PlanItemStatus,
  PlanUnitType,
  QuestionOrigin,
  QuestionStatus,
  QuestionType,
  QuizKind,
  QuizMode,
  ReviewReason,
  ReviewSource,
  ReviewStatus,
  ScopeNodeSource,
  SchoolYear,
  StudySessionKind,
} from '../enums.ts';
import type { ProfileSettings } from './jsonb.ts';

/** Knowledge-map formula (`Formula` jsonb, data-model §1.2). */
export interface Formula {
  latex: string;
  description: string;
}

type Iso = string;
type LocalDay = string;
type Uuid = string;

/** Columns every [sync] table carries (data-model §1.3). */
export interface SyncedRow {
  updated_at: Iso;
  deleted_at: Iso | null;
}

export interface IdentifiedRow extends SyncedRow {
  id: Uuid;
  created_at: Iso;
}

// ---------------------------------------------------------------- identity and preferences

export interface ProfileRow extends SyncedRow {
  id: Uuid;
  display_name: string;
  display_name_status: DisplayNameStatus;
  avatar_preset: string | null;
  avatar_path: string | null;
  birth_year: number;
  birth_month: number;
  school_year: SchoolYear | null;
  timezone: string;
  foreign_language: ForeignLanguage | null;
  app_role: AppRole;
  settings: ProfileSettings;
  onboarding_completed_at: Iso | null;
  created_at: Iso;
}

export interface StudyPreferencesRow extends SyncedRow {
  user_id: Uuid;
  minutes_by_weekday: number[];
  window_start: string;
  window_end: string;
  min_block_min: number;
  max_block_min: number;
  max_subjects_per_day: number;
  quiet_start: string;
  quiet_end: string;
  vespera_time: string;
  day_rollover_hour: number;
  enem_min_share: number;
  review_seconds_estimate: number;
}

// ---------------------------------------------------------------- subjects and knowledge map

export interface SubjectRow extends IdentifiedRow {
  owner_profile_id: Uuid | null;
  owner_class_group_id: Uuid | null;
  created_by: Uuid;
  name: string;
  color: string;
  icon: string;
  content_language: string | null;
  is_language_subject: boolean;
  enem_area: EnemArea | null;
}

export interface SubjectUserSettingRow extends SyncedRow {
  user_id: Uuid;
  subject_id: Uuid;
  pinned: boolean;
  sort_order: number;
  archived_at: Iso | null;
}

export interface KnowledgeNodeRow extends IdentifiedRow {
  subject_id: Uuid;
  parent_id: Uuid | null;
  kind: NodeKind;
  title: string;
  summary: string | null;
  position: number;
  learning_objectives: string[];
  key_terms: string[];
  formulas: Formula[];
  enem_skill_codes: string[];
  is_placeholder: boolean;
  est_learn_minutes: number | null;
  edited_by_user: boolean;
  origin_document_id: Uuid | null;
  content_status: ContentStatus;
  hidden_reason: HiddenReason | null;
}

export interface NodeSourceRow extends IdentifiedRow {
  node_id: Uuid;
  document_id: Uuid;
  page_start: number;
  page_end: number;
  origin: 'ai' | 'user';
}

export interface NodeUserSettingRow extends SyncedRow {
  user_id: Uuid;
  node_id: Uuid;
  excluded: boolean;
}

export interface GlossaryTermRow extends IdentifiedRow {
  subject_id: Uuid;
  node_id: Uuid | null;
  term: string;
  normalized_term: string;
  aliases: string[];
  definition: string | null;
  example: string | null;
  source_pages: SourcePage[];
  version: number;
  hidden_reason: HiddenReason | null;
}

// ---------------------------------------------------------------- content

export interface NoteRow extends IdentifiedRow {
  subject_id: Uuid;
  node_id: Uuid | null;
  scope_kind: NoteScopeKind;
  depth: NoteDepth;
  body: string;
  citations: Citation[];
  language: string;
  word_count: number;
  has_math: boolean;
  status: NoteStatus;
  supersedes_note_id: Uuid | null;
  low_citation_coverage: boolean;
  contributors: Uuid[];
  created_by: Uuid | null;
}

export interface NoteHighlightRow extends IdentifiedRow {
  user_id: Uuid;
  note_id: Uuid;
  start: number;
  end: number;
  quote: string;
  color: HighlightColor;
  orphaned: boolean;
}

export interface CardRow extends IdentifiedRow {
  subject_id: Uuid;
  node_id: Uuid;
  concept_id: Uuid | null;
  type: CardType;
  front: string;
  back: string;
  media: unknown | null;
  has_math: boolean;
  sibling_group_id: Uuid | null;
  cloze_index: number | null;
  source_pages: SourcePage[];
  origin: CardOrigin;
  created_by: Uuid | null;
  personal_for_user_id: Uuid | null;
  status: CardStatus;
  hidden_reason: HiddenReason | null;
  version: number;
}

export interface CardOverrideRow extends SyncedRow {
  user_id: Uuid;
  card_id: Uuid;
  front: string | null;
  back: string | null;
  media: unknown | null;
}

export interface QuestionRow extends IdentifiedRow {
  subject_id: Uuid;
  node_id: Uuid;
  concept_ids: Uuid[];
  type: QuestionType;
  stem: string;
  stimulus: unknown | null;
  texto_base: unknown | null;
  payload: Record<string, unknown>;
  explanation: string | null;
  bloom_level: BloomLevel | null;
  difficulty: number | null;
  difficulty_band: DifficultyBand | null;
  fixed_order: boolean;
  has_math: boolean;
  source_pages: SourcePage[];
  origin: QuestionOrigin;
  answer_key_source: AnswerKeySource | null;
  personal_for_user_id: Uuid | null;
  review_status: ReviewStatus;
  status: QuestionStatus;
  hidden_reason: HiddenReason | null;
  version: number;
}

export interface FeedItemRow extends IdentifiedRow {
  subject_id: Uuid;
  node_id: Uuid;
  concept_id: Uuid | null;
  type: FeedItemType;
  content: Record<string, unknown>;
  media_path: string | null;
  source_pages: SourcePage[];
  external_knowledge: boolean;
  personal_for_user_id: Uuid | null;
  status: FeedItemStatus;
}

// ---------------------------------------------------------------- learning state

export interface CardStateRow {
  user_id: Uuid;
  card_id: Uuid;
  subject_id: Uuid;
  due: Iso;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  learning_steps: number;
  last_review: Iso | null;
  suspended: boolean;
  hidden: boolean;
  is_leech: boolean;
  introduced_at: Iso | null;
  last_log_id: Uuid | null;
  updated_at: Iso;
}

/** Append-only (ADR 0007): no updated_at, no deleted_at. */
export interface ReviewLogRow {
  id: Uuid;
  user_id: Uuid;
  card_id: Uuid;
  rating: 1 | 2 | 3 | 4;
  reviewed_at: Iso;
  client_reviewed_at: Iso;
  elapsed_days: number | null;
  scheduled_days: number | null;
  state_before: 0 | 1 | 2 | 3 | null;
  duration_ms: number | null;
  source: ReviewSource;
  reason: ReviewReason;
  hint_used: boolean;
  undoes_log_id: Uuid | null;
  device_id: string | null;
  clock_skew: boolean;
  created_at: Iso;
}

export interface MasteryRow {
  user_id: Uuid;
  node_id: Uuid;
  subject_id: Uuid;
  mastery: number;
  retrievability: number | null;
  evidence_count: number;
  last_evidence_at: Iso | null;
  updated_at: Iso;
}

export interface MistakeRow extends IdentifiedRow {
  user_id: Uuid;
  question_id: Uuid;
  attempt_answer_id: Uuid;
  subject_id: Uuid;
  node_id: Uuid;
  cause: MistakeCause | null;
  suggested_cause: MistakeCause | null;
  cause_source: CauseSource;
  user_note: string | null;
  next_retry_at: LocalDay;
  retry_step: number;
  success_days: number;
  remediation_card_id: Uuid | null;
  resolved_at: Iso | null;
}

export interface QuizRow extends IdentifiedRow {
  owner_id: Uuid;
  subject_id: Uuid | null;
  goal_id: Uuid | null;
  exam_id: Uuid | null;
  class_group_id: Uuid | null;
  kind: QuizKind;
  mode: QuizMode;
  title: string | null;
  question_ids: Uuid[];
  time_limit_s: number | null;
  scope: Record<string, unknown>;
  config: Record<string, unknown>;
  seed: number;
}

export interface QuizAttemptRow extends IdentifiedRow {
  user_id: Uuid;
  quiz_id: Uuid;
  status: AttemptStatus;
  started_at: Iso;
  finished_at: Iso | null;
  paused_seconds: number;
  device_id: string;
  score: number | null;
  grade: number | null;
  area_results: unknown | null;
  essay_id: Uuid | null;
}

export interface AttemptAnswerRow extends IdentifiedRow {
  attempt_id: Uuid;
  user_id: Uuid;
  question_id: Uuid;
  question_version: number;
  response: unknown | null;
  correct: boolean | null;
  score: number | null;
  points_awarded: number | null;
  points_max: number | null;
  grading_status: GradingStatus;
  grader_confidence: ConfidenceLevel | null;
  confidence: 1 | 2 | 3 | 4 | null;
  time_spent_ms: number;
  hints_used: number;
  solution_viewed: boolean;
  marked_for_review: boolean;
  self_override: boolean;
  typo_tolerated: boolean;
  assisted: boolean;
  input_mode: InputMode;
  essay_id: Uuid | null;
  answered_at: Iso;
}

// ---------------------------------------------------------------- goals, exams, plan

export interface GoalRow extends IdentifiedRow {
  user_id: Uuid;
  mode: GoalMode;
  name: string;
  start_date: LocalDay;
  end_date: LocalDay;
  status: GoalStatus;
  term_index: number | null;
  school_year: number | null;
  settings: Record<string, unknown>;
}

export interface ExamRow extends IdentifiedRow {
  goal_id: Uuid;
  user_id: Uuid;
  subject_id: Uuid | null;
  title: string;
  local_date: LocalDay;
  starts_at: Iso | null;
  duration_min: number | null;
  kind: ExamKind;
  status: ExamStatus;
  parent_exam_id: Uuid | null;
  teacher_name: string | null;
  weight: number | null;
  scope_status: ExamScopeStatus;
  grade: number | null;
  grade_max: number | null;
}

export interface ExamScopeNodeRow extends SyncedRow {
  exam_id: Uuid;
  node_id: Uuid;
  scope_item_id: Uuid | null;
  source: ScopeNodeSource;
  confidence: number | null;
  confirmed: boolean;
}

export interface PlanItemRow extends IdentifiedRow {
  user_id: Uuid;
  goal_id: Uuid | null;
  plan_run_id: Uuid;
  local_date: LocalDay;
  subject_id: Uuid | null;
  exam_id: Uuid | null;
  node_ids: Uuid[];
  unit_type: PlanUnitType;
  minutes: number;
  deadline: LocalDay | null;
  priority: number;
  order_in_day: number;
  demanding: boolean;
  pinned: boolean;
  status: PlanItemStatus;
  reason_key: string | null;
  reason_params: Record<string, unknown> | null;
  completed_session_id: Uuid | null;
}

export interface StudySessionRow extends IdentifiedRow {
  user_id: Uuid;
  kind: StudySessionKind;
  plan_item_id: Uuid | null;
  goal_id: Uuid | null;
  started_at: Iso;
  ended_at: Iso | null;
  active_minutes: number;
  activities: { type: string; ref_id?: Uuid; count: number }[];
  planned_focus_minutes: number | null;
  cycles_planned: number | null;
  cycles_done: number | null;
  interruptions: number | null;
  blocked_attempts: number | null;
  dnd_used: boolean;
}

// ---------------------------------------------------------------- activity and motivation (Phase 2)

export interface DailyActivityRow extends SyncedRow {
  user_id: Uuid;
  local_date: LocalDay;
  active_minutes: number;
  reviews: number;
  questions: number;
  sessions: number;
  xp: number;
  goal_minutes: number;
  goal_met: boolean;
  counted: boolean;
  shield_used: boolean;
  rest_day: boolean;
  late_night_minutes: number;
}

export interface StreakRow extends SyncedRow {
  user_id: Uuid;
  current_length: number;
  longest_length: number;
  last_counted_date: LocalDay | null;
  shields_available: 0 | 1 | 2;
  days_since_last_shield_earned: number;
  rest_weekday: number | null;
}

export interface AchievementRow extends SyncedRow {
  user_id: Uuid;
  code: string;
  progress: number;
  unlocked_at: Iso | null;
  show_in_turma: boolean;
}
