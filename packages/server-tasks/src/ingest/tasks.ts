// Bridge from @studify/prompts (task builders, Zod schemas) to @studify/ai (TaskCall, TaskDef).
// The prompts TaskDef builds `messages` and `system` in the Messages API shape already; this file only
// renames fields, attaches the real Zod schema (needed for the JSON schema sent to the API) and records
// which slice each document block refers to, so citations map back to original pages.
import { getTask, AcheOErroItems, Outline, PageTranscriptions, PrereqEdges, ProblemSet, TopicCards, TopicConcepts, TopicQuestions, FeedItems, GlossaryTerms, TrailLesson, TrailPlan, TrailReinforcement, WrittenChapters, type BuiltPrompt, type PdfSlice, type TextBlock } from '@studify/prompts';
import { choicesFromPages } from '@studify/ai';
import type { BudgetContext, Choices, DocumentSlice, SystemBlock, TaskCall, TaskDef as AiTaskDef } from '@studify/ai';
import type { z } from 'zod';

/** Schema per structured task (the prompts TaskDef does not expose its Zod schema). */
const SCHEMA_BY_TASK: Readonly<Record<string, z.ZodType>> = {
  'ingest.outline': Outline,
  'ingest.outlineMerge': Outline,
  'ingest.writeChapters': WrittenChapters,
  'ingest.topicDetail': TopicConcepts,
  'ingest.prerequisites': PrereqEdges,
  'ingest.transcribePages': PageTranscriptions,
  'glossary.define': GlossaryTerms,
  'cards.generate': TopicCards,
  'questions.generate': TopicQuestions,
  'feed.generate': FeedItems,
  'acheOErro.generate': AcheOErroItems,
  'problems.generate': ProblemSet,
  // The Trilha content written ahead (lib/trail-content.ts).
  'trail.plan': TrailPlan,
  'trail.lesson': TrailLesson,
  'trail.reinforce': TrailReinforcement,
};

const cache = new Map<string, AiTaskDef<unknown>>();

/** The @studify/ai TaskDef for a prompts task id. Throws for unknown tasks. */
export function aiTask(taskId: string): AiTaskDef<unknown> {
  const hit = cache.get(taskId);
  if (hit) return hit;
  const def = getTask(taskId);
  let output: AiTaskDef<unknown>['output'];
  if (def.outputMode === 'structured') {
    const schema = SCHEMA_BY_TASK[taskId];
    if (!schema) throw new Error(`no schema registered for structured task ${taskId}`);
    output = { mode: 'structured', schema: schema as z.ZodType<unknown> };
  } else {
    output = { mode: def.outputMode };
  }
  const task: AiTaskDef<unknown> = {
    id: def.id,
    version: def.version,
    features: def.features,
    effort: def.effort,
    maxTokensClass: def.maxTokensClass,
    output,
  };
  cache.set(taskId, task);
  return task;
}

/** Prompts-side slice: the document block source is either base64 (sync, Batch) or a Files API id. */
export interface SliceRef {
  /** document_slices.id */
  id: string;
  documentId: string;
  title: string;
  pages: number[];
  /** The topic's own pages when `pages` also holds context pages (topicSliceRefs). */
  focusPages?: number[];
  tokenCount: number | null;
  source: { kind: 'base64'; data: string } | { kind: 'file'; fileId: string };
}

export function toPdfSlices(refs: readonly SliceRef[]): PdfSlice[] {
  return refs.map((ref) => ({
    documentId: ref.documentId,
    title: ref.title,
    pages: ref.pages,
    ...(ref.focusPages ? { focusPages: ref.focusPages } : {}),
    source:
      ref.source.kind === 'base64'
        ? { type: 'base64' as const, media_type: 'application/pdf' as const, data: ref.source.data }
        : { type: 'file' as const, file_id: ref.source.fileId },
  }));
}

/** Source list in the same order as the document blocks of the built prompt (labels D1…Dn). */
export function toDocumentSlices(refs: readonly SliceRef[]): DocumentSlice[] {
  return refs.map((ref) => ({
    id: ref.id,
    documentId: ref.documentId,
    title: ref.title,
    pages: ref.pages,
    tokenCount: ref.tokenCount,
    ...(ref.source.kind === 'base64' ? { base64: ref.source.data } : { anthropicFileId: ref.source.fileId }),
  }));
}

function toSystem(blocks: readonly TextBlock[]): SystemBlock[] {
  return blocks.map((b) => {
    const ttl = b.cache_control?.ttl;
    return ttl ? { text: b.text, cacheTtl: ttl } : { text: b.text };
  });
}

export interface PreparedCall {
  call: TaskCall<unknown>;
  built: BuiltPrompt;
}

/**
 * Builds the TaskCall for one prompts task. `slices` must be the slices that were passed to the
 * prompts builder, in the same order: the builder labels them D1…Dn in that order.
 */
export function prepareCall(
  taskId: string,
  built: BuiltPrompt,
  ctx: BudgetContext,
  slices: readonly SliceRef[],
  choices: Choices = {},
): PreparedCall {
  const task = aiTask(taskId);
  const call: TaskCall<unknown> = {
    task,
    ctx,
    system: toSystem(built.system),
    messages: built.messages as unknown as TaskCall<unknown>['messages'],
    sources: toDocumentSlices(slices),
    // Labels and pages sent (and the caller's keys) as schema enums: the output cannot cite anything else.
    choices: { ...choicesFromPages(built.documents?.allowedPages), ...choices },
  };
  return { call, built };
}

/** Structured-output tasks in a batch carry the same prompt as the sync path (ai-pipeline §7.2). */
export type { BuiltPrompt };
