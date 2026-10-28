// Public surface of the planning module (GOL-04 … GOL-12). Relative imports use explicit `.ts` extensions.
export {
  GRADING_PRESET_IDS,
  GRADING_PRESETS,
  GradingFormulaSchema,
  formatGradeBr,
  gradingPreset,
  parseGradingFormula,
  requiredGrade,
} from './grading.ts';
export type {
  GradeComponent,
  GradeTarget,
  GradingFormula,
  GradingPresetId,
  RequiredGradeResult,
} from './grading.ts';

export {
  DEFAULT_AVAILABILITY_MINUTES,
  DEFAULT_PLAN_SETTINGS,
  buildPlan,
  estLearnMinutes,
  planInputHash,
  vesperaMinutesForTests,
} from './planner.ts';

export { attackCoverage, desperateEligibility, diagnosticTopics, planAttack } from './desperate.ts';
export type {
  AttackPlan,
  AttackTopic,
  DesperateEligibility,
  DesperateEligibilityInput,
} from './desperate.ts';

export { buildSession } from './session.ts';
export type { SessionBlock, SessionInput, SessionPlan, SessionPlanItem, SessionReviewCard } from './session.ts';

export { fitGradeMapping, predictedGrade, readiness } from './readiness.ts';
export type {
  GradeCalibration,
  PredictedGrade,
  PredictionInput,
  PredictionTopic,
  ReadinessResult,
  ReadinessTopic,
} from './readiness.ts';

export { buildVespera, notifyTime, sleepStopTime } from './vespera.ts';
export type { VesperaExam, VesperaInput, VesperaPart, VesperaScopeTopic, VesperaSession } from './vespera.ts';

export { planDaysUntil, planStudyDayOf } from './calendar.ts';

export type {
  AttackGroup,
  DesperateOptions,
  MaterialKind,
  PlanAvailability,
  PlanDay,
  PlanDayLoad,
  PlanExam,
  PlanInput,
  PlanItem,
  PlanItemState,
  PlanPreviousItem,
  PlanRun,
  PlanSettings,
  PlanTopic,
  PlanTriageStep,
  PlanUnitKind,
  ReplanTrigger,
} from './types.ts';

export {
  ENERGY,
  energyBucketOf,
  performanceResidual,
  performanceWindows,
  mergeIntervals,
  quietIntervals,
  freeIntervals,
  freeMinutes,
  placeBlocks,
  orderByEnergy,
  suggestedReminderTimes,
} from './energy.ts';
export type { ResidualEvent, WindowStat, PerformanceWindows, MinuteInterval, BlockUnit, PlacedBlock } from './energy.ts';

export { learnPace, reviewSecondsFrom, PACE_ALPHA, PACE_MAX, PACE_MIN, PACE_MIN_SAMPLES, REVIEW_SECONDS_MIN_SAMPLES } from './pace.ts';
export type { PaceSample } from './pace.ts';
