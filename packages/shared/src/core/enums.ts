// Canonical value lists for every CHECK-constrained text column of the Phase 0–2 schema.
// Source: docs/engineering/data-model.md §4 (DDL), §5 (value lists), §1.2 (R-decisions).
// A later CI test compares `ENUMS` with the CHECK constraints in supabase/migrations/,
// so every key is exactly `<table>.<column>` (for `private.*` tables: the bare table name).
// Enums are `text` + CHECK in Postgres, never Postgres enum types (data-model §1.1).
import { z } from 'zod';

/** Returns true when `value` is one of `values`. Narrowing helper for untrusted input. */
export function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

// ---------------------------------------------------------------- identity, Turma, safety (§4.1, §5.1)

export const DISPLAY_NAME_STATUS = ['pending', 'approved', 'rejected'] as const;
export type DisplayNameStatus = (typeof DISPLAY_NAME_STATUS)[number];
export const DisplayNameStatusSchema = z.enum(DISPLAY_NAME_STATUS);

// PLT-02 / SP-01: no school name is stored, only the school year band.
export const SCHOOL_YEAR = ['ef9', 'em1', 'em2', 'em3', 'cursinho', 'outro'] as const;
export type SchoolYear = (typeof SCHOOL_YEAR)[number];
export const SchoolYearSchema = z.enum(SCHOOL_YEAR);

// ENM-01: foreign-language option for ENEM.
export const FOREIGN_LANGUAGE = ['en', 'es'] as const;
export type ForeignLanguage = (typeof FOREIGN_LANGUAGE)[number];
export const ForeignLanguageSchema = z.enum(FOREIGN_LANGUAGE);

// R24: app-level role, distinct from Turma roles.
export const APP_ROLE = ['user', 'app_admin'] as const;
export type AppRole = (typeof APP_ROLE)[number];
export const AppRoleSchema = z.enum(APP_ROLE);

// SOC-01.5: default join policy is an owner decision (open-decisions); the DDL default is 'approval'.
export const JOIN_POLICY = ['approval', 'open'] as const;
export type JoinPolicy = (typeof JOIN_POLICY)[number];
export const JoinPolicySchema = z.enum(JOIN_POLICY);

export const MEMBER_ROLE = ['owner', 'moderator', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLE)[number];
export const MemberRoleSchema = z.enum(MEMBER_ROLE);

export const MEMBER_STATUS = ['pending', 'active', 'removed', 'banned', 'left'] as const;
export type MemberStatus = (typeof MEMBER_STATUS)[number];
export const MemberStatusSchema = z.enum(MEMBER_STATUS);

// ---------------------------------------------------------------- subjects and materials (§4.2, §5.2)

// ENM-01 / PLT-03.7; ENEM area codes (R16). RED exists only inside SISU weights.
export const ENEM_AREA = ['LC', 'CH', 'CN', 'MT'] as const;
export type EnemArea = (typeof ENEM_AREA)[number];
export const EnemAreaSchema = z.enum(ENEM_AREA);

export const DOCUMENT_KIND = ['slides', 'notes', 'textbook', 'past_test', 'content_list', 'photo', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KIND)[number];
export const DocumentKindSchema = z.enum(DOCUMENT_KIND);

// R18: `waiting_budget` is not a failure; `error_code` explains `failed`.
export const DOCUMENT_STATUS = ['uploaded', 'processing', 'ready', 'failed', 'waiting_budget'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUS);

// Stored on documents.error_code. The API-level PDF codes (`pdf_corrupt`, ...) map to these values in errors.ts.
export const DOCUMENT_ERROR_CODE = [
  'password_protected',
  'corrupt',
  'empty',
  'too_large',
  'too_many_pages',
  'not_study_material',
  'ai_failed',
  'ai_refused',
  'unsupported_type',
] as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODE)[number];
export const DocumentErrorCodeSchema = z.enum(DOCUMENT_ERROR_CODE);

export const TEXT_SOURCE = ['pdf_text_layer', 'ai_transcription', 'none'] as const;
export type TextSource = (typeof TEXT_SOURCE)[number];
export const TextSourceSchema = z.enum(TEXT_SOURCE);

// Shared by document_pages, content_flags.ai_confidence, attempt_answers.grader_confidence.
export const CONFIDENCE_LEVEL = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVEL)[number];
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVEL);

// ING-02 / ING-01: purposes of document_slices (architecture of Files API slices, R14).
export const SLICE_PURPOSE = ['outline', 'topic', 'transcription', 'tutor'] as const;
export type SlicePurpose = (typeof SLICE_PURPOSE)[number];
export const SlicePurposeSchema = z.enum(SLICE_PURPOSE);

// ING-03 knowledge map. Units are the only roots (DDL check on knowledge_nodes).
export const NODE_KIND = ['unit', 'topic', 'concept'] as const;
export type NodeKind = (typeof NODE_KIND)[number];
export const NodeKindSchema = z.enum(NODE_KIND);

// `ai_refused`: the model refused this topic (spec 01 §7); the rest of the material still proceeds.
export const CONTENT_STATUS = ['pending', 'generating', 'ready', 'failed', 'skipped_excluded', 'ai_refused'] as const;
export type ContentStatus = (typeof CONTENT_STATUS)[number];
export const ContentStatusSchema = z.enum(CONTENT_STATUS);

// R20 / TRU-02: moderation visibility. Shared by knowledge_nodes, cards, questions.
export const HIDDEN_REASON = ['under_review', 'removed'] as const;
export type HiddenReason = (typeof HIDDEN_REASON)[number];
export const HiddenReasonSchema = z.enum(HIDDEN_REASON);

// Origin of node_sources, node_prerequisites (ING-03, LRN-04).
export const ORIGIN_ACTOR = ['ai', 'user'] as const;
export type OriginActor = (typeof ORIGIN_ACTOR)[number];
export const OriginActorSchema = z.enum(ORIGIN_ACTOR);

// ING-04 audit log (undo within 30 days).
export const NODE_EVENT_ACTION = ['create', 'rename', 'reorder', 'move', 'merge', 'split', 'delete', 'restore'] as const;
export type NodeEventAction = (typeof NODE_EVENT_ACTION)[number];
export const NodeEventActionSchema = z.enum(NODE_EVENT_ACTION);

export const SCHEDULE_IMPORT_STATUS = ['draft', 'applied', 'discarded'] as const;
export type ScheduleImportStatus = (typeof SCHEDULE_IMPORT_STATUS)[number];
export const ScheduleImportStatusSchema = z.enum(SCHEDULE_IMPORT_STATUS);

// LRN-04.1 (Phase 2).
export const NODE_RELATION_KIND = ['related', 'contrast'] as const;
export type NodeRelationKind = (typeof NODE_RELATION_KIND)[number];
export const NodeRelationKindSchema = z.enum(NODE_RELATION_KIND);

// ---------------------------------------------------------------- cards and review state (§4.3)

// MEM-01: basic, cloze, reverse; image_occlusion arrives in Phase 3 but the CHECK already lists it.
export const CARD_TYPE = ['basic', 'cloze', 'reverse', 'image_occlusion'] as const;
export type CardType = (typeof CARD_TYPE)[number];
export const CardTypeSchema = z.enum(CARD_TYPE);

export const CARD_ORIGIN = ['generated', 'user', 'from_mistake', 'from_tutor'] as const;
export type CardOrigin = (typeof CARD_ORIGIN)[number];
export const CardOriginSchema = z.enum(CARD_ORIGIN);

export const CARD_STATUS = ['active', 'archived'] as const;
export type CardStatus = (typeof CARD_STATUS)[number];
export const CardStatusSchema = z.enum(CARD_STATUS);

// ADR 0007 / review_logs.source: where the rating came from.
export const REVIEW_SOURCE = ['session', 'feed', 'widget', 'notification', 'map', 'vespera'] as const;
export type ReviewSource = (typeof REVIEW_SOURCE)[number];
export const ReviewSourceSchema = z.enum(REVIEW_SOURCE);

// ADR 0007 / review_logs.reason: exam_boost reviews are scheduled because of an exam (MEM-02).
export const REVIEW_REASON = ['scheduled', 'exam_boost', 'early'] as const;
export type ReviewReason = (typeof REVIEW_REASON)[number];
export const ReviewReasonSchema = z.enum(REVIEW_REASON);

// ---------------------------------------------------------------- questions (§4.3, PRA)

export const QUESTION_TYPE = [
  'mcq_single',
  'multi_select',
  'true_false',
  'fill_blank',
  'numeric',
  'matching',
  'ordering',
  'short_answer',
  'essay_question',
  'find_error',
  'problem',
] as const;
export type QuestionType = (typeof QUESTION_TYPE)[number];
export const QuestionTypeSchema = z.enum(QUESTION_TYPE);

export const BLOOM_LEVEL = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'] as const;
export type BloomLevel = (typeof BLOOM_LEVEL)[number];
export const BloomLevelSchema = z.enum(BLOOM_LEVEL);

// ENEM difficulty bands (ENM-03).
export const DIFFICULTY_BAND = ['facil', 'media', 'dificil', 'muito_dificil'] as const;
export type DifficultyBand = (typeof DIFFICULTY_BAND)[number];
export const DifficultyBandSchema = z.enum(DIFFICULTY_BAND);

export const QUESTION_ORIGIN = ['generated', 'past_test', 'enem_official', 'peer', 'photo', 'user'] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGIN)[number];
export const QuestionOriginSchema = z.enum(QUESTION_ORIGIN);

export const ANSWER_KEY_SOURCE = ['printed', 'generated', 'official'] as const;
export type AnswerKeySource = (typeof ANSWER_KEY_SOURCE)[number];
export const AnswerKeySourceSchema = z.enum(ANSWER_KEY_SOURCE);

// SOC-07: peer-question review (only for origin = peer).
export const REVIEW_STATUS = ['approved', 'pending', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];
export const ReviewStatusSchema = z.enum(REVIEW_STATUS);

// R20: `disputed` while an answer-key flag is open.
export const QUESTION_STATUS = ['active', 'archived', 'disputed'] as const;
export type QuestionStatus = (typeof QUESTION_STATUS)[number];
export const QuestionStatusSchema = z.enum(QUESTION_STATUS);

// ---------------------------------------------------------------- notes, explanations, feed (§5.2–5.3)

// LRN-01: `class_summary` is the SOC-06 class-summary depth.
export const NOTE_DEPTH = ['tldr', 'study', 'deep', 'class_summary'] as const;
export type NoteDepth = (typeof NOTE_DEPTH)[number];
export const NoteDepthSchema = z.enum(NOTE_DEPTH);

export const NOTE_SCOPE_KIND = ['topic', 'subject_overview'] as const;
export type NoteScopeKind = (typeof NOTE_SCOPE_KIND)[number];
export const NoteScopeKindSchema = z.enum(NOTE_SCOPE_KIND);

// R4: `superseded` notes point back with supersedes_note_id (undo after "Refazer resumo").
export const NOTE_STATUS = ['pending', 'generating', 'ready', 'failed', 'superseded'] as const;
export type NoteStatus = (typeof NOTE_STATUS)[number];
export const NoteStatusSchema = z.enum(NOTE_STATUS);

// LRN-01.10.
export const HIGHLIGHT_COLOR = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLOR)[number];
export const HighlightColorSchema = z.enum(HIGHLIGHT_COLOR);

// LRN-03.
export const EXPLANATION_TARGET = [
  'note_paragraph',
  'concept',
  'glossary_term',
  'question_explanation',
  'card_back',
  'trail_step',
] as const;
export type ExplanationTarget = (typeof EXPLANATION_TARGET)[number];
export const ExplanationTargetSchema = z.enum(EXPLANATION_TARGET);

export const EXPLANATION_STYLE = ['simpler', 'analogy', 'example', 'step_by_step'] as const;
export type ExplanationStyle = (typeof EXPLANATION_STYLE)[number];
export const ExplanationStyleSchema = z.enum(EXPLANATION_STYLE);

// FED-01.
export const FEED_ITEM_TYPE = ['micro_lesson', 'quick_question', 'diagram', 'did_you_know'] as const;
export type FeedItemType = (typeof FEED_ITEM_TYPE)[number];
export const FeedItemTypeSchema = z.enum(FEED_ITEM_TYPE);

export const FEED_ITEM_STATUS = ['active', 'archived'] as const;
export type FeedItemStatus = (typeof FEED_ITEM_STATUS)[number];
export const FeedItemStatusSchema = z.enum(FEED_ITEM_STATUS);

export const FEED_IMPRESSION_KIND = ['feed_item', 'card', 'mistake'] as const;
export type FeedImpressionKind = (typeof FEED_IMPRESSION_KIND)[number];
export const FeedImpressionKindSchema = z.enum(FEED_IMPRESSION_KIND);

export const FEED_IMPRESSION_ACTION = ['answered', 'rated', 'read', 'skipped', 'hidden'] as const;
export type FeedImpressionAction = (typeof FEED_IMPRESSION_ACTION)[number];
export const FeedImpressionActionSchema = z.enum(FEED_IMPRESSION_ACTION);

// R19: content item types, shared by content_flags, item_revisions and item_hides.
export const ITEM_TYPE = [
  'knowledge_node',
  'note',
  'glossary_term',
  'card',
  'question',
  'explanation',
  'feed_item',
  'podcast_episode',
  'tutor_message',
  'visual',
  'document',
] as const;
export type ItemType = (typeof ITEM_TYPE)[number];
export const ItemTypeSchema = z.enum(ITEM_TYPE);

// R7: item_hides never takes `card` (cards use card_states.hidden).
export const ITEM_HIDE_TYPE = [
  'knowledge_node',
  'note',
  'glossary_term',
  'question',
  'explanation',
  'feed_item',
  'podcast_episode',
  'tutor_message',
  'visual',
  'document',
] as const;
export type ItemHideType = (typeof ITEM_HIDE_TYPE)[number];
export const ItemHideTypeSchema = z.enum(ITEM_HIDE_TYPE);

// TRU-02.3 "Excluir pra mim" reasons.
export const HIDE_REASON = ['not_useful', 'wrong', 'duplicate', 'other'] as const;
export type HideReason = (typeof HIDE_REASON)[number];
export const HideReasonSchema = z.enum(HIDE_REASON);

// TRU-02 content flags.
export const FLAG_REASON = [
  'wrong_answer',
  'wrong_fact',
  'wrong_page',
  'unclear',
  'inappropriate',
  'copyright',
  'other',
] as const;
export type FlagReason = (typeof FLAG_REASON)[number];
export const FlagReasonSchema = z.enum(FLAG_REASON);

export const AI_VERDICT = ['confirmed', 'rejected', 'unsure'] as const;
export type AiVerdict = (typeof AI_VERDICT)[number];
export const AiVerdictSchema = z.enum(AI_VERDICT);

export const FLAG_STATUS = [
  'open',
  'triaged',
  'hidden_pending',
  'accepted',
  'rejected',
  'removed',
  'superseded',
] as const;
export type FlagStatus = (typeof FLAG_STATUS)[number];
export const FlagStatusSchema = z.enum(FLAG_STATUS);

// ---------------------------------------------------------------- goals, exams, plan (§4.4, §5.5)

// GOL-01 / PLT: goal modes. `enem` is the ENEM goal (Phase 4) but the CHECK exists from Phase 0.
export const GOAL_MODE = ['exam_week', 'enem'] as const;
export type GoalMode = (typeof GOAL_MODE)[number];
export const GoalModeSchema = z.enum(GOAL_MODE);

export const GOAL_STATUS = ['active', 'completed', 'archived'] as const;
export type GoalStatus = (typeof GOAL_STATUS)[number];
export const GoalStatusSchema = z.enum(GOAL_STATUS);

// GOL-06: `recuperacao` exams point to the original via parent_exam_id.
export const EXAM_KIND = ['regular', 'recuperacao', 'final'] as const;
export type ExamKind = (typeof EXAM_KIND)[number];
export const ExamKindSchema = z.enum(EXAM_KIND);

// `draft` comes from ING-07 schedule imports until the student applies them.
export const EXAM_STATUS = ['draft', 'scheduled', 'done', 'cancelled'] as const;
export type ExamStatus = (typeof EXAM_STATUS)[number];
export const ExamStatusSchema = z.enum(EXAM_STATUS);

// GOL-03 / R2: scope review state.
export const EXAM_SCOPE_STATUS = ['none', 'pending_review', 'confirmed'] as const;
export type ExamScopeStatus = (typeof EXAM_SCOPE_STATUS)[number];
export const ExamScopeStatusSchema = z.enum(EXAM_SCOPE_STATUS);

export const SCOPE_ITEM_STATUS = ['matched', 'partial', 'unmatched'] as const;
export type ScopeItemStatus = (typeof SCOPE_ITEM_STATUS)[number];
export const ScopeItemStatusSchema = z.enum(SCOPE_ITEM_STATUS);

export const SCOPE_NODE_SOURCE = ['ai', 'user', 'default_all'] as const;
export type ScopeNodeSource = (typeof SCOPE_NODE_SOURCE)[number];
export const ScopeNodeSourceSchema = z.enum(SCOPE_NODE_SOURCE);

// GOL-06.2.
export const GRADE_COMPONENT_KIND = ['exam', 'assignment', 'other'] as const;
export type GradeComponentKind = (typeof GRADE_COMPONENT_KIND)[number];
export const GradeComponentKindSchema = z.enum(GRADE_COMPONENT_KIND);

// GOL-04 planner unit types.
export const PLAN_UNIT_TYPE = [
  'learn',
  'learn_light',
  'practice',
  'mock',
  'vespera',
  'warmup',
  'review',
  'upload_material',
  'essay',
] as const;
export type PlanUnitType = (typeof PLAN_UNIT_TYPE)[number];
export const PlanUnitTypeSchema = z.enum(PLAN_UNIT_TYPE);

export const PLAN_ITEM_STATUS = ['planned', 'done', 'skipped', 'moved'] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUS)[number];
export const PlanItemStatusSchema = z.enum(PLAN_ITEM_STATUS);

// GOL-04.9 / GOL-12 replan triggers.
export const PLAN_TRIGGER = [
  'goal_created',
  'exam_changed',
  'scope_changed',
  'day_missed',
  'grade_logged',
  'user_rebalance',
  'nightly',
  'availability_changed',
  'material_added',
  'desperate_on',
  'desperate_off',
  'mastery_shift',
  'manual_edit',
] as const;
export type PlanTrigger = (typeof PLAN_TRIGGER)[number];
export const PlanTriggerSchema = z.enum(PLAN_TRIGGER);

export const COMPUTED_BY = ['server', 'device'] as const;
export type ComputedBy = (typeof COMPUTED_BY)[number];
export const ComputedBySchema = z.enum(COMPUTED_BY);

// R17: study session kinds.
export const STUDY_SESSION_KIND = [
  'mixed',
  'review',
  'practice',
  'simulado',
  'feed',
  'focus',
  'vespera',
  'tutor',
  'teaching',
  'podcast',
] as const;
export type StudySessionKind = (typeof STUDY_SESSION_KIND)[number];
export const StudySessionKindSchema = z.enum(STUDY_SESSION_KIND);

// GOL-04.3 / GOL-09.2 availability exceptions.
export const AVAILABILITY_SOURCE = ['user', 'calendar', 'desperate'] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCE)[number];
export const AvailabilitySourceSchema = z.enum(AVAILABILITY_SOURCE);

// GOL-12 Modo Desespero.
export const DESPERATE_STATUS = ['active', 'ended', 'cancelled'] as const;
export type DesperateStatus = (typeof DESPERATE_STATUS)[number];
export const DesperateStatusSchema = z.enum(DESPERATE_STATUS);

// ---------------------------------------------------------------- mastery and practice (§4.3–4.4, §5.4)

// R13 / learning-engine: evidence sources. `diagnostic` comes from Modo Desespero (GOL-12), `trail` from the Trilha (TRL-01).
export const MASTERY_SOURCE = [
  'quiz_answer',
  'review',
  'tutor_quiz',
  'feed_question',
  'duel',
  'battle',
  'teaching',
  'boss',
  'simulado',
  'diagnostic',
  'trail',
] as const;
export type MasterySource = (typeof MASTERY_SOURCE)[number];
export const MasterySourceSchema = z.enum(MASTERY_SOURCE);

// TRL-01 (spec 14): the Trilha and its steps.
export const TRAIL_STATUS = ['active', 'completed'] as const;
export type TrailStatus = (typeof TRAIL_STATUS)[number];
export const TRAIL_STEP_PURPOSE = ['lesson', 'practice', 'remedial_lesson', 'remedial_question', 'checkpoint'] as const;
export type TrailStepPurposeName = (typeof TRAIL_STEP_PURPOSE)[number];
export const TRAIL_STEP_STATUS = ['ready', 'done', 'discarded'] as const;
export type TrailStepStatusName = (typeof TRAIL_STEP_STATUS)[number];

// R6: quiz kinds.
export const QUIZ_KIND = [
  'practice',
  'mock_exam',
  'mistake_retry',
  'feed',
  'predicted_test',
  'boss',
  'duel',
  'battle',
  'enem_simulado',
  'trail',
] as const;
export type QuizKind = (typeof QUIZ_KIND)[number];
export const QuizKindSchema = z.enum(QUIZ_KIND);

// `diagnostic`: the GOL-12.3 quick check of Modo Desespero (a practice quiz with this mode).
export const QUIZ_MODE = ['practice', 'exam_conditions', 'relaxed', 'diagnostic'] as const;
export type QuizMode = (typeof QUIZ_MODE)[number];
export const QuizModeSchema = z.enum(QUIZ_MODE);

export const ATTEMPT_STATUS = ['in_progress', 'submitted', 'expired', 'abandoned'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];
export const AttemptStatusSchema = z.enum(ATTEMPT_STATUS);

export const GRADING_STATUS = ['graded', 'pending', 'failed', 'self_graded'] as const;
export type GradingStatus = (typeof GRADING_STATUS)[number];
export const GradingStatusSchema = z.enum(GRADING_STATUS);

// Shared by attempt_answers, essays, camera_captures (typed or photographed input).
export const INPUT_MODE = ['typed', 'photo'] as const;
export type InputMode = (typeof INPUT_MODE)[number];
export const InputModeSchema = z.enum(INPUT_MODE);

// R16 / PRA-04: mistake causes (spelling per R16, not the spec aliases).
export const MISTAKE_CAUSE = ['didnt_know', 'confused', 'careless', 'misread'] as const;
export type MistakeCause = (typeof MISTAKE_CAUSE)[number];
export const MistakeCauseSchema = z.enum(MISTAKE_CAUSE);

export const CAUSE_SOURCE = ['suggested', 'user'] as const;
export type CauseSource = (typeof CAUSE_SOURCE)[number];
export const CauseSourceSchema = z.enum(CAUSE_SOURCE);

// R5: one essays table for ENEM redações and long school answers.
export const ESSAY_KIND = ['enem_redacao', 'school_answer'] as const;
export type EssayKind = (typeof ESSAY_KIND)[number];
export const EssayKindSchema = z.enum(ESSAY_KIND);

export const ESSAY_STATUS = ['draft', 'grading', 'graded', 'failed'] as const;
export type EssayStatus = (typeof ESSAY_STATUS)[number];
export const EssayStatusSchema = z.enum(ESSAY_STATUS);

// PRA-09.4 teacher profile confidence and PRA-09.6 prediction targets.
export const TEACHER_CONFIDENCE = ['low', 'mid', 'high'] as const;
export type TeacherConfidence = (typeof TEACHER_CONFIDENCE)[number];
export const TeacherConfidenceSchema = z.enum(TEACHER_CONFIDENCE);

export const PREDICTION_TARGET = ['exam', 'enem_goal'] as const;
export type PredictionTarget = (typeof PREDICTION_TARGET)[number];
export const PredictionTargetSchema = z.enum(PREDICTION_TARGET);

// ---------------------------------------------------------------- tutor (§5.6)

// TUT-01 scope; `capture` is set by CAM-01.4 in Phase 3.
export const TUTOR_SCOPE_TYPE = ['subject', 'goal', 'topic', 'passage', 'capture'] as const;
export type TutorScopeType = (typeof TUTOR_SCOPE_TYPE)[number];
export const TutorScopeTypeSchema = z.enum(TUTOR_SCOPE_TYPE);

export const TUTOR_MODE = ['answer', 'socratic', 'quiz'] as const;
export type TutorMode = (typeof TUTOR_MODE)[number];
export const TutorModeSchema = z.enum(TUTOR_MODE);

export const TUTOR_ROLE = ['user', 'assistant', 'system_note'] as const;
export type TutorRole = (typeof TUTOR_ROLE)[number];
export const TutorRoleSchema = z.enum(TUTOR_ROLE);

export const TUTOR_MESSAGE_STATUS = ['streaming', 'complete', 'interrupted', 'refused', 'failed'] as const;
export type TutorMessageStatus = (typeof TUTOR_MESSAGE_STATUS)[number];
export const TutorMessageStatusSchema = z.enum(TUTOR_MESSAGE_STATUS);

// `distress` is set by the [[APOIO]] marker (WEL / safety copy).
export const SAFETY_FLAG = ['distress', 'blocked_content'] as const;
export type SafetyFlag = (typeof SAFETY_FLAG)[number];
export const SafetyFlagSchema = z.enum(SAFETY_FLAG);

// ---------------------------------------------------------------- Turma, social, moderation (§4, §5.7)

// SOC-02 duels.
export const DUEL_STATUS = ['waiting_opponent', 'declined', 'finished', 'expired', 'cancelled'] as const;
export type DuelStatus = (typeof DUEL_STATUS)[number];
export const DuelStatusSchema = z.enum(DUEL_STATUS);

// SOC-03 live battles.
export const BATTLE_STATUS = [
  'lobby',
  'question_open',
  'question_closed',
  'reveal',
  'podium',
  'ended',
  'cancelled',
] as const;
export type BattleStatus = (typeof BATTLE_STATUS)[number];
export const BattleStatusSchema = z.enum(BATTLE_STATUS);

// PLT-05 notification channels (Android channel ids, mobile-app §5.1).
export const NOTIFICATION_CHANNEL = ['reviews', 'plan', 'class', 'processing'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL)[number];
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNEL);

export const DROPPED_REASON = ['daily_cap', 'quiet_hours_superseded', 'disabled', 'no_token'] as const;
export type DroppedReason = (typeof DROPPED_REASON)[number];
export const DroppedReasonSchema = z.enum(DROPPED_REASON);

// SP-03 guardian link.
export const GUARDIAN_LINK_STATUS = ['pending', 'active', 'revoked'] as const;
export type GuardianLinkStatus = (typeof GUARDIAN_LINK_STATUS)[number];
export const GuardianLinkStatusSchema = z.enum(GUARDIAN_LINK_STATUS);

// SP-09 user reports.
export const REPORT_REASON = [
  'harassment',
  'inappropriate_name',
  'inappropriate_content',
  'spam',
  'copyright',
  'self_harm_concern',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASON)[number];
export const ReportReasonSchema = z.enum(REPORT_REASON);

export const REPORT_STATUS = ['open', 'actioned', 'dismissed', 'escalated'] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];
export const ReportStatusSchema = z.enum(REPORT_STATUS);

// private.moderation_actions (append-only audit, retained ≥ 5 years).
export const MODERATION_ACTOR_KIND = ['moderator', 'owner', 'app_admin', 'system'] as const;
export type ModerationActorKind = (typeof MODERATION_ACTOR_KIND)[number];
export const ModerationActorKindSchema = z.enum(MODERATION_ACTOR_KIND);

export const MODERATION_ACTION = [
  'hide',
  'remove',
  'restore',
  'ban',
  'unban',
  'remove_member',
  'takedown',
  'appeal_upheld',
  'appeal_rejected',
] as const;
export type ModerationAction = (typeof MODERATION_ACTION)[number];
export const ModerationActionSchema = z.enum(MODERATION_ACTION);

// ---------------------------------------------------------------- motivation and AI operations (§5.9, §5.11)

// LRN-04.7 / WEL-03 (R10): nudge kinds and user actions.
export const NUDGE_KIND = [
  'prerequisite_detective',
  'long_session',
  'daily_load',
  'late_night',
  'performance_drop',
  'overload_trend',
  'checkin_low',
] as const;
export type NudgeKind = (typeof NUDGE_KIND)[number];
export const NudgeKindSchema = z.enum(NUDGE_KIND);

export const NUDGE_ACTION = ['acted', 'dismissed', 'accepted', 'disabled'] as const;
export type NudgeAction = (typeof NUDGE_ACTION)[number];
export const NudgeActionSchema = z.enum(NUDGE_ACTION);

// PLT-04 budgets (private.ai_budgets).
export const BUDGET_SCOPE_TYPE = ['user', 'class_group', 'global'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPE)[number];
export const BudgetScopeTypeSchema = z.enum(BUDGET_SCOPE_TYPE);

export const BUDGET_PERIOD = ['day', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIOD)[number];
export const BudgetPeriodSchema = z.enum(BUDGET_PERIOD);

export const AI_JOB_STATUS = [
  'queued',
  'running',
  'waiting_batch',
  'waiting_budget',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type AiJobStatus = (typeof AI_JOB_STATUS)[number];
export const AiJobStatusSchema = z.enum(AI_JOB_STATUS);

// SP-14 data exports and account deletions.
export const EXPORT_STATUS = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUS)[number];
export const ExportStatusSchema = z.enum(EXPORT_STATUS);

export const DELETION_REQUESTER = ['self', 'guardian'] as const;
export type DeletionRequester = (typeof DELETION_REQUESTER)[number];
export const DeletionRequesterSchema = z.enum(DELETION_REQUESTER);

export const DELETION_STATUS = ['pending', 'running', 'done', 'failed'] as const;
export type DeletionStatus = (typeof DELETION_STATUS)[number];
export const DeletionStatusSchema = z.enum(DELETION_STATUS);

// ---------------------------------------------------------------- camera, interactive learning, rooms (§5.7–5.8, Phase 3)

// CAM-00.2: what the student wants from the photo.
export const CAPTURE_INTENT = ['explain', 'solve', 'add_to_subject', 'grade_answer', 'grade_essay'] as const;
export type CaptureIntent = (typeof CAPTURE_INTENT)[number];
export const CaptureIntentSchema = z.enum(CAPTURE_INTENT);

// CAM-01.1 Step A classification.
export const CAPTURE_CONTENT_TYPE = ['book_page', 'whiteboard', 'handwritten_notes', 'exercise', 'essay', 'other'] as const;
export type CaptureContentType = (typeof CAPTURE_CONTENT_TYPE)[number];
export const CaptureContentTypeSchema = z.enum(CAPTURE_CONTENT_TYPE);

export const CAPTURE_STATUS = ['queued', 'processing', 'ready', 'failed'] as const;
export type CaptureStatus = (typeof CAPTURE_STATUS)[number];
export const CaptureStatusSchema = z.enum(CAPTURE_STATUS);

// INT-01.2: Resumão, Aprofundado, Revisão pra prova.
export const PODCAST_STYLE = ['overview', 'deep', 'exam_review'] as const;
export type PodcastStyle = (typeof PODCAST_STYLE)[number];
export const PodcastStyleSchema = z.enum(PODCAST_STYLE);

// data-model §5.8 (api §4.8): 5, 10 or 15 minutes. Numeric, so not part of the CHECK registry below.
export const PODCAST_LENGTHS = [5, 10, 15] as const;
export type PodcastLength = (typeof PODCAST_LENGTHS)[number];

export const PODCAST_STATUS = ['queued', 'scripting', 'synthesizing', 'ready', 'failed'] as const;
export type PodcastStatus = (typeof PODCAST_STATUS)[number];
export const PodcastStatusSchema = z.enum(PODCAST_STATUS);

// INT-01.8, WEL-04.9: how a question reached the server (the text of on-device STT, or typed).
export const VOICE_INPUT_MODE = ['voice', 'text'] as const;
export type VoiceInputMode = (typeof VOICE_INPUT_MODE)[number];
export const VoiceInputModeSchema = z.enum(VOICE_INPUT_MODE);

// INT-02.2: Rápido (6 turns) or Completo (12 turns).
export const TEACHING_LENGTH = ['short', 'full'] as const;
export type TeachingLength = (typeof TEACHING_LENGTH)[number];
export const TeachingLengthSchema = z.enum(TEACHING_LENGTH);

export const TEACHING_STATUS = ['active', 'finished', 'abandoned'] as const;
export type TeachingStatus = (typeof TEACHING_STATUS)[number];
export const TeachingStatusSchema = z.enum(TEACHING_STATUS);

// SOC-05 study rooms.
export const ROOM_STATUS = ['open', 'closed'] as const;
export type RoomStatus = (typeof ROOM_STATUS)[number];
export const RoomStatusSchema = z.enum(ROOM_STATUS);

// SOC-05.2: presence shows what the member studies, or only "Estudando".
export const ROOM_STATUS_MODE = ['auto', 'hidden'] as const;
export type RoomStatusMode = (typeof ROOM_STATUS_MODE)[number];
export const RoomStatusModeSchema = z.enum(ROOM_STATUS_MODE);

// SOC-05.5: the only interaction in a room.
export const ROOM_REACTIONS = ['👏', '🔥', '💪', '☕', '😴', '🎉'] as const;
export type RoomReaction = (typeof ROOM_REACTIONS)[number];
export const RoomReactionSchema = z.enum(ROOM_REACTIONS);

// ---------------------------------------------------------------- ENEM mode and Argumentação (§5.10, Phase 4)

// System-owned subjects that hold global content (the ENEM bank, Atualidades questions).
export const SYSTEM_SUBJECT_KIND = ['enem_bank', 'atualidades'] as const;
export type SystemSubjectKind = (typeof SYSTEM_SUBJECT_KIND)[number];

// ENM-08.1: dates confirmed by the INEP edital (with a verification stamp) or provisional.
export const ENEM_DATES_STATUS = ['official', 'provisional'] as const;
export type EnemDatesStatus = (typeof ENEM_DATES_STATUS)[number];

export const ENEM_APPLICATION = ['regular', 'ppl', 'other'] as const;
export type EnemApplication = (typeof ENEM_APPLICATION)[number];
export const EnemApplicationSchema = z.enum(ENEM_APPLICATION);

export const ENEM_LANGUAGE = ['en', 'es'] as const;
export type EnemLanguage = (typeof ENEM_LANGUAGE)[number];

export const ENEM_ANSWER_KEY = ['A', 'B', 'C', 'D', 'E'] as const;
export type EnemAnswerKey = (typeof ENEM_ANSWER_KEY)[number];
export const EnemAnswerKeySchema = z.enum(ENEM_ANSWER_KEY);

// ENM-02.9: an imported item is published only after review.
export const ENEM_REVIEW_STATUS = ['ok', 'needs_review'] as const;
export type EnemReviewStatus = (typeof ENEM_REVIEW_STATUS)[number];

export const ENEM_EXPLANATION_STATUS = ['pending', 'ok', 'flagged'] as const;
export type EnemExplanationStatus = (typeof ENEM_EXPLANATION_STATUS)[number];

// Spec 09 §8.4.1: `std` is the N(0,1) scale; `enem` is the published 500/100 scale (converted before use).
export const TRI_PARAM_SCALE = ['std', 'enem'] as const;
export type TriParamScale = (typeof TRI_PARAM_SCALE)[number];

export const TOPIC_TREND = ['up', 'flat', 'down'] as const;
export type TopicTrend = (typeof TOPIC_TREND)[number];
export const TopicTrendSchema = z.enum(TOPIC_TREND);

export const ESSAY_THEME_SOURCE = ['past_enem', 'predicted', 'atualidades', 'custom'] as const;
export type EssayThemeSource = (typeof ESSAY_THEME_SOURCE)[number];
export const EssayThemeSourceSchema = z.enum(ESSAY_THEME_SOURCE);

export const DIGEST_STATUS = ['draft', 'published', 'withdrawn'] as const;
export type DigestStatus = (typeof DIGEST_STATUS)[number];

// ENM-05: Repertório kinds and the verification outcome of repertorio.verify.
export const REPERTORIO_KIND = ['quote', 'data', 'law', 'work', 'event'] as const;
export type RepertorioKind = (typeof REPERTORIO_KIND)[number];
export const RepertorioKindSchema = z.enum(REPERTORIO_KIND);

export const REPERTORIO_VERIFIED = ['yes', 'no', 'contradicted'] as const;
export type RepertorioVerified = (typeof REPERTORIO_VERIFIED)[number];
export const RepertorioVerifiedSchema = z.enum(REPERTORIO_VERIFIED);

export const SISU_OFFER_SOURCE = ['open_data', 'edital', 'manual_admin'] as const;
export type SisuOfferSource = (typeof SISU_OFFER_SOURCE)[number];

// ENM-09 Argumentação.
export const ARGUMENT_GOAL_MODE = ['exam_week', 'enem'] as const;
export type ArgumentGoalMode = (typeof ARGUMENT_GOAL_MODE)[number];
export const ArgumentGoalModeSchema = z.enum(ARGUMENT_GOAL_MODE);

export const ARGUMENT_THEME_SOURCE = ['suggested', 'enem', 'custom'] as const;
export type ArgumentThemeSource = (typeof ARGUMENT_THEME_SOURCE)[number];
export const ArgumentThemeSourceSchema = z.enum(ARGUMENT_THEME_SOURCE);

export const ARGUMENT_MODE = ['debate', 'build'] as const;
export type ArgumentMode = (typeof ARGUMENT_MODE)[number];
export const ArgumentModeSchema = z.enum(ARGUMENT_MODE);

export const ARGUMENT_STATUS = ['active', 'finished', 'abandoned'] as const;
export type ArgumentStatus = (typeof ARGUMENT_STATUS)[number];

// ---------------------------------------------------------------- Phase 5

/** LRN-05.1 visual types; `none` caches "Esse tópico não fica bom em diagrama" (LRN-05.2). */
export const VISUAL_TYPE = ['flowchart', 'timeline', 'comparison_table', 'hierarchy', 'cycle', 'none'] as const;
export type VisualType = (typeof VISUAL_TYPE)[number];
export const VisualTypeSchema = z.enum(VISUAL_TYPE);

export const VISUAL_STATUS = ['ready', 'failed'] as const;
export type VisualStatus = (typeof VISUAL_STATUS)[number];

/** ING-06.1 finding types. */
export const FINDING_TYPE = ['contradiction', 'numeric_or_formula_typo', 'skipped_step', 'unclear'] as const;
export type FindingType = (typeof FINDING_TYPE)[number];
export const FindingTypeSchema = z.enum(FINDING_TYPE);

export const FINDING_SEVERITY = ['low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY)[number];
export const FindingSeveritySchema = z.enum(FINDING_SEVERITY);

export const FINDING_STATUS = ['open', 'dismissed', 'confirmed'] as const;
export type FindingStatus = (typeof FINDING_STATUS)[number];

export const FINDING_VOTE = ['not_error', 'is_error'] as const;
export type FindingVote = (typeof FINDING_VOTE)[number];

/** MEM-06.2 mnemonic types. */
export const MNEMONIC_TYPE = ['acronym', 'phrase', 'rhyme', 'story', 'palace', 'keyword'] as const;
export type MnemonicType = (typeof MNEMONIC_TYPE)[number];
export const MnemonicTypeSchema = z.enum(MNEMONIC_TYPE);

export const DIVIDE_STATUS = ['open', 'merging', 'done', 'cancelled'] as const;
export type DivideStatus = (typeof DIVIDE_STATUS)[number];

export const CONTRIBUTION_STATUS = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUS)[number];

export const CONTRIBUTION_INPUT_MODE = ['typed', 'photo'] as const;
export type ContributionInputMode = (typeof CONTRIBUTION_INPUT_MODE)[number];

/** MOT-04.1 Retrospectiva periods. */
export const RETRO_PERIOD = ['goal', 'semester', 'year'] as const;
export type RetroPeriodKind = (typeof RETRO_PERIOD)[number];

// ---------------------------------------------------------------- feature IDs (PRD §5 catalog)

// Every PRD feature ID. `ai_usage.feature` and `xp_events.source_feature` store these (data-model §1.1).
// Kept in catalog order; test/core/enums.test.ts compares this list with docs/product/PRD.md §5.
export const FEATURE_IDS = [
  'PLT-01', 'PLT-02', 'PLT-03', 'PLT-04', 'PLT-05', 'PLT-06', 'PLT-07',
  'ING-01', 'ING-02', 'ING-03', 'ING-04', 'ING-05', 'ING-06', 'ING-07', 'ING-08',
  'LRN-01', 'LRN-02', 'LRN-03', 'LRN-04', 'LRN-05',
  'MEM-01', 'MEM-02', 'MEM-03', 'MEM-04', 'MEM-05', 'MEM-06',
  'FED-01',
  'PRA-01', 'PRA-02', 'PRA-03', 'PRA-04', 'PRA-05', 'PRA-06', 'PRA-07', 'PRA-08', 'PRA-09',
  'TUT-01', 'TUT-02', 'TUT-03', 'TUT-04', 'TUT-05', 'TUT-06',
  'GOL-01', 'GOL-02', 'GOL-03', 'GOL-04', 'GOL-05', 'GOL-06', 'GOL-07', 'GOL-08', 'GOL-09', 'GOL-10', 'GOL-11', 'GOL-12',
  'SOC-01', 'SOC-02', 'SOC-03', 'SOC-04', 'SOC-05', 'SOC-06', 'SOC-07', 'SOC-08', 'SOC-09',
  'CAM-01', 'CAM-02', 'CAM-03',
  'INT-01', 'INT-02', 'INT-03',
  'ENM-01', 'ENM-02', 'ENM-03', 'ENM-04', 'ENM-05', 'ENM-06', 'ENM-07', 'ENM-08', 'ENM-09', 'ENM-10',
  'MOT-01', 'MOT-02', 'MOT-03', 'MOT-04',
  'WEL-01', 'WEL-02', 'WEL-03', 'WEL-04',
  'TRU-01', 'TRU-02',
  'TRL-01',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export const FeatureIdSchema = z.enum(FEATURE_IDS);

// ---------------------------------------------------------------- registry for the CI comparison

/**
 * Every CHECK-constrained column in the Phase 0–2 schema, keyed `table.column`.
 * `private.*` tables use their bare table name as the key prefix.
 * Numeric ranges (review_logs.rating, card_states.state, ...) and free-text columns are not listed.
 */
export const ENUMS: Readonly<Record<string, readonly string[]>> = {
  'profiles.display_name_status': DISPLAY_NAME_STATUS,
  'profiles.school_year': SCHOOL_YEAR,
  'profiles.foreign_language': FOREIGN_LANGUAGE,
  'profiles.app_role': APP_ROLE,
  'class_groups.join_policy': JOIN_POLICY,
  'class_group_members.role': MEMBER_ROLE,
  'class_group_members.status': MEMBER_STATUS,
  'subjects.enem_area': ENEM_AREA,
  'documents.kind': DOCUMENT_KIND,
  'documents.detected_kind': DOCUMENT_KIND,
  'documents.status': DOCUMENT_STATUS,
  'documents.error_code': DOCUMENT_ERROR_CODE,
  'document_pages.text_source': TEXT_SOURCE,
  'document_pages.transcription_confidence': CONFIDENCE_LEVEL,
  'document_slices.purpose': SLICE_PURPOSE,
  'knowledge_nodes.kind': NODE_KIND,
  'knowledge_nodes.content_status': CONTENT_STATUS,
  'knowledge_nodes.hidden_reason': HIDDEN_REASON,
  'node_sources.origin': ORIGIN_ACTOR,
  'node_prerequisites.origin': ORIGIN_ACTOR,
  'node_events.action': NODE_EVENT_ACTION,
  'node_relations.kind': NODE_RELATION_KIND,
  'schedule_imports.status': SCHEDULE_IMPORT_STATUS,
  'cards.type': CARD_TYPE,
  'cards.origin': CARD_ORIGIN,
  'cards.status': CARD_STATUS,
  'cards.hidden_reason': HIDDEN_REASON,
  'review_logs.source': REVIEW_SOURCE,
  'review_logs.reason': REVIEW_REASON,
  'questions.type': QUESTION_TYPE,
  'questions.bloom_level': BLOOM_LEVEL,
  'questions.difficulty_band': DIFFICULTY_BAND,
  'questions.origin': QUESTION_ORIGIN,
  'questions.answer_key_source': ANSWER_KEY_SOURCE,
  'questions.review_status': REVIEW_STATUS,
  'questions.status': QUESTION_STATUS,
  'questions.hidden_reason': HIDDEN_REASON,
  'notes.depth': NOTE_DEPTH,
  'notes.scope_kind': NOTE_SCOPE_KIND,
  'notes.status': NOTE_STATUS,
  'note_highlights.color': HIGHLIGHT_COLOR,
  'explanations.target_type': EXPLANATION_TARGET,
  'explanations.style': EXPLANATION_STYLE,
  'feed_items.type': FEED_ITEM_TYPE,
  'feed_items.status': FEED_ITEM_STATUS,
  'feed_impressions.item_kind': FEED_IMPRESSION_KIND,
  'feed_impressions.action': FEED_IMPRESSION_ACTION,
  'item_revisions.item_type': ITEM_TYPE,
  'item_hides.item_type': ITEM_HIDE_TYPE,
  'item_hides.reason': HIDE_REASON,
  'content_flags.item_type': ITEM_TYPE,
  'content_flags.reason': FLAG_REASON,
  'content_flags.ai_verdict': AI_VERDICT,
  'content_flags.ai_confidence': CONFIDENCE_LEVEL,
  'content_flags.status': FLAG_STATUS,
  'goals.mode': GOAL_MODE,
  'goals.status': GOAL_STATUS,
  'exams.kind': EXAM_KIND,
  'exams.status': EXAM_STATUS,
  'exams.scope_status': EXAM_SCOPE_STATUS,
  'exam_scope_items.status': SCOPE_ITEM_STATUS,
  'exam_scope_nodes.source': SCOPE_NODE_SOURCE,
  'grade_components.kind': GRADE_COMPONENT_KIND,
  'plan_items.unit_type': PLAN_UNIT_TYPE,
  'plan_items.status': PLAN_ITEM_STATUS,
  'plan_runs.trigger': PLAN_TRIGGER,
  'plan_runs.computed_by': COMPUTED_BY,
  'study_sessions.kind': STUDY_SESSION_KIND,
  'availability_exceptions.source': AVAILABILITY_SOURCE,
  'desperate_modes.status': DESPERATE_STATUS,
  'mastery_evidence.source': MASTERY_SOURCE,
  'trails.status': TRAIL_STATUS,
  'trail_steps.purpose': TRAIL_STEP_PURPOSE,
  'trail_steps.status': TRAIL_STEP_STATUS,
  'quizzes.kind': QUIZ_KIND,
  'quizzes.mode': QUIZ_MODE,
  'quiz_attempts.status': ATTEMPT_STATUS,
  'attempt_answers.grading_status': GRADING_STATUS,
  'attempt_answers.grader_confidence': CONFIDENCE_LEVEL,
  'attempt_answers.input_mode': INPUT_MODE,
  'mistakes.cause': MISTAKE_CAUSE,
  'mistakes.suggested_cause': MISTAKE_CAUSE,
  'mistakes.cause_source': CAUSE_SOURCE,
  'essays.kind': ESSAY_KIND,
  'essays.input_mode': INPUT_MODE,
  'essays.status': ESSAY_STATUS,
  'tutor_threads.scope_type': TUTOR_SCOPE_TYPE,
  'tutor_threads.mode': TUTOR_MODE,
  'tutor_messages.role': TUTOR_ROLE,
  'tutor_messages.status': TUTOR_MESSAGE_STATUS,
  'tutor_messages.safety_flag': SAFETY_FLAG,
  'teacher_profiles.confidence': TEACHER_CONFIDENCE,
  'topic_predictions.target_type': PREDICTION_TARGET,
  'duels.status': DUEL_STATUS,
  'battles.status': BATTLE_STATUS,
  'notification_log.channel': NOTIFICATION_CHANNEL,
  'notification_inbox.channel': NOTIFICATION_CHANNEL,
  'notification_log.dropped_reason': DROPPED_REASON,
  'guardian_links.status': GUARDIAN_LINK_STATUS,
  'user_reports.reason': REPORT_REASON,
  'user_reports.status': REPORT_STATUS,
  'moderation_actions.actor_kind': MODERATION_ACTOR_KIND,
  'moderation_actions.action': MODERATION_ACTION,
  'nudge_events.kind': NUDGE_KIND,
  'nudge_events.action': NUDGE_ACTION,
  'ai_budgets.scope_type': BUDGET_SCOPE_TYPE,
  'ai_budgets.period_type': BUDGET_PERIOD,
  'ai_budget_limits.scope_type': BUDGET_SCOPE_TYPE,
  'ai_jobs.status': AI_JOB_STATUS,
  'data_exports.status': EXPORT_STATUS,
  'account_deletions.requested_by': DELETION_REQUESTER,
  'account_deletions.status': DELETION_STATUS,
  // Phase 3
  'camera_captures.intent': CAPTURE_INTENT,
  'camera_captures.content_type': CAPTURE_CONTENT_TYPE,
  'camera_captures.status': CAPTURE_STATUS,
  'podcast_episodes.style': PODCAST_STYLE,
  'podcast_episodes.status': PODCAST_STATUS,
  'podcast_interactions.input_mode': VOICE_INPUT_MODE,
  'teaching_sessions.length': TEACHING_LENGTH,
  'teaching_sessions.status': TEACHING_STATUS,
  'study_rooms.status': ROOM_STATUS,
  'study_room_members.status_mode': ROOM_STATUS_MODE,
  // Phase 4
  'subjects.system_kind': SYSTEM_SUBJECT_KIND,
  'enem_editions.dates_status': ENEM_DATES_STATUS,
  'enem_skills.area': ENEM_AREA,
  'enem_topics.area': ENEM_AREA,
  'enem_items.application': ENEM_APPLICATION,
  'enem_items.area': ENEM_AREA,
  'enem_items.answer_key': ENEM_ANSWER_KEY,
  'enem_items.language': ENEM_LANGUAGE,
  'enem_items.explanation_status': ENEM_EXPLANATION_STATUS,
  'enem_items.review_status': ENEM_REVIEW_STATUS,
  'enem_item_params.scale': TRI_PARAM_SCALE,
  'enem_topic_stats.area': ENEM_AREA,
  'enem_topic_trends.trend': TOPIC_TREND,
  'enem_redacao_themes.application': ENEM_APPLICATION,
  'essay_themes.source': ESSAY_THEME_SOURCE,
  'atualidades_digests.status': DIGEST_STATUS,
  'repertorio_items.kind': REPERTORIO_KIND,
  'repertorio_items.verified': REPERTORIO_VERIFIED,
  'sisu_offers.source': SISU_OFFER_SOURCE,
  'argument_sessions.goal_mode': ARGUMENT_GOAL_MODE,
  'argument_sessions.theme_source': ARGUMENT_THEME_SOURCE,
  'argument_sessions.mode': ARGUMENT_MODE,
  'argument_sessions.status': ARGUMENT_STATUS,
  // Phase 5
  'visuals.type': VISUAL_TYPE,
  'visuals.status': VISUAL_STATUS,
  'material_findings.type': FINDING_TYPE,
  'material_findings.severity': FINDING_SEVERITY,
  'material_findings.status': FINDING_STATUS,
  'material_finding_votes.vote': FINDING_VOTE,
  'mnemonics.type': MNEMONIC_TYPE,
  'divide_plans.status': DIVIDE_STATUS,
  'contributions.input_mode': CONTRIBUTION_INPUT_MODE,
  'contributions.status': CONTRIBUTION_STATUS,
  'retrospectives.period_type': RETRO_PERIOD,
};
