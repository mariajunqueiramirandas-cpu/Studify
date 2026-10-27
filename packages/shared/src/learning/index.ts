// Public surface of the learning engine (learning-engine §1). Pure functions only: callers load
// inputs, call these, and persist outputs. Internal helpers (rng, util) are not exported.

export type {
  Rating,
  CardKind,
  LearningParams,
  CardState,
  ReviewLog,
  ReviewLogDraft,
  RatingPreview,
  RecoveryPlan,
  ExamScope,
  EvidenceQuestionType,
  EvidenceSource,
  Confidence,
  EvidenceEvent,
  EvidenceAggregate,
  MasteryRetrievabilitySource,
  MasteryResult,
  QueueEntry,
  ForecastDay,
} from './types.ts';

export { DEFAULT_LEARNING_PARAMS, resolveParams, EXAM_WINDOW_DAYS, QUOTA, MASTERY, MASTERY_DEFAULTS, SELECTION, MISTAKES, CALIBRATION, FEED, LEECH, BACKLOG, MOTIVATION, SOCIAL } from './params.ts';

export {
  newCardState,
  isIntroduced,
  scheduleReview,
  previewRatings,
  formatIntervalPt,
  retrievability,
  isLeech,
  leechPromptOnLapse,
  backlogRecovery,
  dropUndonePairs,
  clampFutureTimestamp,
  compareReviewLogs,
  dropCrossDeviceDoubles,
  canonicalReviewLogs,
  replayCard,
  replayReviewLogs,
} from './fsrs.ts';

export {
  activeExamScopes,
  siblingsToBury,
  examDue,
  effectiveDue,
  examsForConcept,
  buildReviewQueue,
  forecastReviewLoad,
  medianReviewSeconds,
} from './queue.ts';
export type { QueueCard, QueueInput, EffectiveDue, ForecastOptions } from './queue.ts';

export { newCardQuota } from './quota.ts';
export type { QuotaExam, NewCardQuotaInput, NewCardQuota, QuotaBlock } from './quota.ts';

export {
  evidenceWeight,
  decayFactor,
  emptyAggregate,
  foldEvidence,
  decayedSums,
  accuracyAt,
  emptyLedger,
  recordEvidence,
  ancestorsOf,
  aggregateEvidence,
  masteryAt,
  masteryOrDefault,
  detectMasteryShift,
} from './mastery.ts';
export type { EvidenceLedger, MasteryInput } from './mastery.ts';

export {
  difficultyDelta,
  predictSuccess,
  refitPredictionModel,
  DEFAULT_PREDICTION_MODEL,
  examUrgency,
  adaptiveScore,
  selectAdaptiveQuiz,
  composeSimulado,
  simuladoGrade,
  empiricalDifficultyBands,
  nextRecallKind,
  pickMeTestaNode,
  selectDuelQuestions,
} from './selection.ts';
export type {
  PredictionModel,
  PredictionObservation,
  QuizCandidate,
  SimuladoCandidate,
  SimuladoInput,
  SimuladoResult,
  EmpiricalStat,
  RecallKind,
  MeTestaNode,
  DuelCandidate,
  DuelSelectionInput,
} from './selection.ts';

export {
  suggestCause,
  rePracticeFor,
  mistakeEntryAction,
  newRetrySchedule,
  applyRetryOutcome,
  nextRetry,
  retriesDue,
} from './mistakes.ts';
export type { RePracticeStep, AnswerFacts, RetrySchedule } from './mistakes.ts';

export { expectedConfidence, brierScore, calibration, isOverconfident } from './calibration.ts';
export type { RatedAnswer, CalibrationState, CalibrationBucket, ReliabilityBin, CalibrationReport } from './calibration.ts';

export { feedPriority, duePressure, rankFeed } from './feed.ts';
export type { FeedPoolKey, FeedItem, FeedContext, FeedPools, FeedRound } from './feed.ts';

export { retrievabilityBand, glowOpacity, BAND_LABEL_PT, conceptRetrievability, topicRetrievability, prerequisiteNudge } from './map.ts';
export type { RetrievabilityBand, DetectiveNode } from './map.ts';

export {
  xpFor,
  levelThreshold,
  levelFor,
  initialStreakState,
  isCountedDay,
  autoRestDays,
  evaluateStreak,
  activeMinutesByStudyDay,
  ACHIEVEMENTS,
  achievementProgress,
  bestWeekGoalDays,
} from './motivation.ts';
export type {
  XpEvent,
  XpDayContext,
  DailyActivity,
  StreakState,
  AchievementDefinition,
  AchievementCode,
  AchievementMetricName,
  AchievementMetrics,
  AchievementProgress,
} from './motivation.ts';

export {
  duelAnswerSeconds,
  duelPoints,
  isDuelTimeout,
  battlePoints,
  isBattleAnswerRejected,
  roundRate,
  classInsightDisplay,
  topicInsight,
  DISTRIBUTION_MIN_ANSWERS,
  LEADERBOARD_SIZE,
  PODIUM_SIZE,
  battleTopic,
  leaderboardTop,
  battleDistributionOf,
  battleChoiceOf,
  battlePublicQuestion,
  battleStateEvent,
  battleRevealEvent,
  battlePodiumEvent,
} from './social.ts';
export type {
  InsightAggregate,
  InsightDisplay,
  ClassInsight,
  BattleStatusName,
  BattlePlayerScore,
  BattleLeaderboardEntry,
  BattleRealtimeEvent,
} from './social.ts';

// Phase 5
export { SKILL_TREE, skillNodeState, skillTreeLayout, bossQuestionCount, selectBossQuestions, bossHealth, bossPassed } from './skilltree.ts';
export type { SkillNodeState, SkillNodeInput, SkillNodeView, SkillTreeUnit, SkillTreeTopic, SkillTreeLayout, BossCandidate } from './skilltree.ts';

export { capiStage, capiMood, CAPI_RESTING_DAYS, CAPI_ACCESSORIES, isAccessoryUnlocked, equippedAccessories } from './capi.ts';
export type { CapiStage, CapiMood, CapiMoodInput, CapiSlot, CapiAccessory } from './capi.ts';

export { LEAGUE, leagueWeekXp, rankLeague, leagueBadges, visibleBoard } from './league.ts';
export type { LeagueXpEvent, LeagueEntryInput, RankedLeagueEntry } from './league.ts';

export { DEFAULT_SEMESTER_ENDS, YEAR_RETRO_DAY, retroPeriodsDue, retroCards, retroFallbackTitle } from './retro.ts';
export type { RetroPeriodType, RetroPeriod, RetroGoalInput, RetroStats, RetroCard } from './retro.ts';

export {
  FOCUS_PRESETS,
  FOCUS_LIMITS,
  validateFocusConfig,
  focusPhases,
  focusTotalMinutes,
  blockingAllowed,
  focusPositionAt,
  completedFocusCycles,
  BURNOUT,
  isLateNight,
  burnoutNudges,
  HELP_CARD,
} from './wellbeing.ts';
export type { FocusConfig, FocusPhase, FocusPosition, BurnoutNudgeKind, BurnoutInput, BurnoutNudge } from './wellbeing.ts';

export { MNEMONICS, acronymOf, encodesItems, placeOnLoci, isMnemonicList } from './mnemonics.ts';

export { MAX_FINDINGS_PER_DOCUMENT, FINDING_CONFIRMATIONS, findingStatus, rankFindings, visibleFindings } from './material.ts';
export type { FindingSeverityName, FindingStatusName, FindingLike } from './material.ts';

export { VISUAL_LIMITS, visualSpecErrors, flowchartLayout, cycleLayout, hierarchyLayout, timelineOrder } from './visuals.ts';
export type { VisualNode, VisualSpecShape, PlacedNode } from './visuals.ts';
