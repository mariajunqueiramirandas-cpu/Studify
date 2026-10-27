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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTaskDef = TaskDef<any, any>;

/** Every Phase 0–2 task. Order is the registry order (stable, used by snapshots). */
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
  prova.pastTestExtract,
  prova.teacherProfileBuild,
  prova.predictedTestGenerate,
  trust.flagTriage,
  trust.moderationClassify,
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
