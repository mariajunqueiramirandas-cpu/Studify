import type { TaskDef } from '../define.ts';
import * as ingest from './ingest.ts';
import * as learn from './learn.ts';
import * as tutor from './tutor.ts';
import * as cards from './cards.ts';
import * as practice from './practice.ts';
import * as feed from './feed.ts';
import * as goals from './goals.ts';
import * as prova from './prova.ts';
import * as trust from './trust.ts';
import * as camera from './camera.ts';
import * as practice3 from './practice3.ts';
import * as interactive from './interactive.ts';
import * as enem from './enem.ts';
import * as argument from './argument.ts';
import * as phase5 from './phase5.ts';
import * as trail from './trail.ts';

export * from './shared.ts';
export * from './ingest.ts';
export * from './learn.ts';
export * from './tutor.ts';
export * from './cards.ts';
export * from './practice.ts';
export * from './feed.ts';
export * from './goals.ts';
export * from './prova.ts';
export * from './trust.ts';
export * from './camera.ts';
export * from './practice3.ts';
export * from './interactive.ts';
export * from './enem.ts';
export * from './argument.ts';
export * from './phase5.ts';
export * from './trail.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTaskDef = TaskDef<any, any>;

/** Every task of Phases 0–5 and the Trilha. Order is the registry order (stable, used by snapshots). */
export const TASKS: readonly AnyTaskDef[] = [
  ingest.ingestOutline,
  ingest.ingestOutlineMerge,
  ingest.ingestTopicDetail,
  ingest.ingestPrerequisites,
  ingest.ingestTranscribePages,
  ingest.ingestScheduleExtract,
  ingest.scopeMatch,
  learn.notesTldr,
  learn.notesStudy,
  learn.notesDeep,
  learn.notesSubjectSummary,
  learn.glossaryDefine,
  learn.explainRestyle,
  learn.mapRelations,
  tutor.tutorTurn,
  tutor.tutorRoute,
  tutor.tutorGeneral,
  tutor.tutorSummary,
  tutor.tutorToCard,
  cards.cardsGenerate,
  cards.cardsMore,
  cards.cardsFromSelection,
  cards.cardsRemediation,
  practice.questionsGenerate,
  practice.questionsMore,
  practice.questionsVariant,
  practice.contrastDrill,
  practice.gradeShortAnswer,
  practice.practiceExplainWrong,
  feed.feedGenerate,
  feed.feedTopUp,
  goals.vesperaCheatsheet,
  goals.goalsDiagnostic,
  goals.planCoach,
  prova.pastTestExtract,
  prova.teacherProfileBuild,
  prova.predictedTestGenerate,
  trust.flagTriage,
  trust.moderationClassify,
  // Phase 3
  camera.cameraUnderstand,
  camera.cameraMatchTiebreak,
  camera.cameraExplain,
  camera.cameraSolveLadder,
  camera.cameraSolveFull,
  camera.cameraTranscribe,
  practice3.gradeEssayQuestion,
  practice3.acheOErroGenerate,
  practice3.problemsGenerate,
  practice3.problemsFirstWrongStep,
  interactive.podcastScript,
  interactive.podcastHandAnswer,
  interactive.lucasPlan,
  interactive.lucasTurn,
  // Phase 4
  enem.enemTagNodes,
  enem.enemBankTranscribe,
  enem.enemBankExplain,
  enem.enemBankTagTopics,
  enem.enemQuestionGenerate,
  enem.essayGrade,
  enem.repertorioVerify,
  enem.repertorioVerifyStructure,
  enem.atualidadesResearch,
  enem.atualidadesStructure,
  enem.enemThemesPredict,
  enem.essayThemePrompt,
  argument.argumentReply,
  argument.argumentReplyGeneral,
  argument.argumentFeedback,
  argument.argumentThesis,
  argument.argumentSummary,
  argument.argumentThemes,
  // Phase 5
  phase5.visualGenerate,
  phase5.materialCheck,
  phase5.mnemonicsSuggest,
  phase5.divideReview,
  phase5.divideMerge,
  phase5.peerValidate,
  phase5.retroTitle,
  // Trilha (TRL-01)
  trail.trailPlan,
  trail.trailLesson,
  trail.trailRemediate,
  trail.trailCheckpoint,
];

function buildIndex(tasks: readonly AnyTaskDef[]): ReadonlyMap<string, AnyTaskDef> {
  const index = new Map<string, AnyTaskDef>();
  for (const task of tasks) {
    if (index.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    index.set(task.id, task);
  }
  return index;
}

export const TASK_BY_ID: ReadonlyMap<string, AnyTaskDef> = buildIndex(TASKS);

export function getTask(id: string): AnyTaskDef {
  const task = TASK_BY_ID.get(id);
  if (!task) throw new Error(`unknown task id: ${id}`);
  return task;
}

/** Registry summary: task id → prompt version → features → output mode (used by the README table). */
export function listTasks(): Array<{
  id: string;
  promptVersion: string;
  features: readonly string[];
  outputMode: string;
  effort: string;
  maxTokensClass: string;
  runs: string;
  budget: string;
}> {
  return TASKS.map((t) => ({
    id: t.id,
    promptVersion: t.promptVersion,
    features: t.features,
    outputMode: t.outputMode,
    effort: t.effort,
    maxTokensClass: t.maxTokensClass,
    runs: t.runs,
    budget: t.budget,
  }));
}
