// Adapter from a @studify/prompts TaskDef (plus its Zod output schema) to the @studify/ai TaskCall
// that callClaude() takes. The prompt builders stay the source of truth for system text, messages
// and document labels; this file only reshapes them and keeps the document map for post-checks.
import { callClaude, choicesFromPages, type BudgetContext, type CallResult, type Choices, type ClaudeDeps, type DocumentSlice, type SystemBlock, type TaskCall } from '@studify/ai';
import type { BuiltPrompt, DocumentMap, TaskDef as PromptTaskDef } from '@studify/prompts';
import type { z } from 'zod';

export interface AiScope {
  userId: string | null;
  classGroupId?: string | null;
  subjectId?: string | null;
  documentId?: string | null;
  nodeId?: string | null;
  jobId?: string | null;
  /** PRD feature id charged to the budget, e.g. "PRA-01.6". */
  feature: string;
}

export interface PromptRun<I, O> {
  task: PromptTaskDef<I, O>;
  /** The Zod schema the task validates with; also used to build output_config.format. */
  schema: z.ZodType<O>;
  input: I;
  scope: AiScope;
  /** Keys the output may use beyond the labels and pages sent (sent as schema enums). */
  choices?: Choices;
}

export interface PromptOutcome<O> {
  result: CallResult<O>;
  /** Document label → stored document id and allowed original pages (null when the prompt has no documents). */
  documents: DocumentMap | null;
}

/** Document labels D1, D2… in block order, as @studify/ai DocumentSlice entries for estimates and citations. */
export function sourcesOf(documents: DocumentMap | undefined): DocumentSlice[] {
  if (!documents) return [];
  return Object.keys(documents.labels)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((label) => ({
      id: `slice-${label}`,
      documentId: documents.labels[label] ?? '',
      title: label,
      pages: documents.allowedPages[label] ?? [],
    }));
}

function systemOf(built: BuiltPrompt): SystemBlock[] {
  return built.system.map((block) => (block.cache_control ? { text: block.text, cacheTtl: block.cache_control.ttl } : { text: block.text }));
}

/**
 * The call with every 1h cache breakpoint turned into 5m. The 1h TTL exists for Batch waves, whose requests can
 * run an hour apart. Worker calls are standard calls: their reuse (retries, the next item of the same task) comes
 * within minutes and every read refreshes the 5m TTL, so a 1h write (2× input) buys nothing over 5m (1.25×).
 */
export function withShortCache<T>(call: TaskCall<T>): TaskCall<T> {
  const system = call.system.map((b) => (b.cacheTtl === '1h' ? { ...b, cacheTtl: '5m' as const } : b));
  const messages = call.messages.map((m) => {
    if (typeof m.content === 'string') return m;
    const content = (m.content as Array<{ cache_control?: { type: 'ephemeral'; ttl?: string } }>).map((b) =>
      b.cache_control?.ttl === '1h' ? { ...b, cache_control: { ...b.cache_control, ttl: '5m' } } : b,
    );
    return { ...m, content } as typeof m;
  });
  return { ...call, system, messages };
}

/** Runs one structured prompt task through callClaude (reserve → call → validate → settle). */
export async function runPrompt<I, O>(deps: ClaudeDeps, run: PromptRun<I, O>): Promise<PromptOutcome<O>> {
  const built = run.task.build(run.input);
  const budget: BudgetContext = {
    userId: run.scope.userId,
    classGroupId: run.scope.classGroupId ?? null,
    subjectId: run.scope.subjectId ?? null,
    documentId: run.scope.documentId ?? null,
    nodeId: run.scope.nodeId ?? null,
    jobId: run.scope.jobId ?? null,
    feature: run.scope.feature,
    budgetClass: run.task.budget,
  };
  const call: TaskCall<O> = {
    task: {
      id: built.taskId,
      version: run.task.version,
      features: run.task.features,
      effort: built.effort,
      maxTokensClass: built.maxTokensClass,
      output: { mode: 'structured', schema: run.schema },
    },
    ctx: budget,
    system: systemOf(built),
    // The builders already put document and image blocks first (ai-pipeline §2.2).
    messages: built.messages as unknown as TaskCall<O>['messages'],
    sources: sourcesOf(built.documents),
    choices: { ...choicesFromPages(built.documents?.allowedPages), ...(run.choices ?? {}) },
  };
  const result = await callClaude(deps, withShortCache(call));
  return { result, documents: built.documents ?? null };
}

/** Maps a document label used by the model (D1…) to its stored id, or null when it is not in the prompt. */
export function documentIdForLabel(documents: DocumentMap | null, label: string): string | null {
  if (!documents) return null;
  return documents.labels[label] ?? null;
}

/** True when every page of `pages` is inside the pages sent for `label` (model-reported evidence, TRU-02.4). */
export function pagesAllowed(documents: DocumentMap | null, label: string, start: number, end: number): boolean {
  if (!documents) return false;
  const allowed = documents.allowedPages[label];
  if (!allowed) return false;
  for (let p = start; p <= end; p++) if (!allowed.includes(p)) return false;
  return true;
}

export interface TextRun<I> {
  task: PromptTaskDef<I, unknown>;
  input: I;
  scope: AiScope;
}

/**
 * Runs a prose task (plain or citations output) with the tools its builder declares, e.g. the web_search server
 * tool of atualidades.research and repertorio.verify. The raw content stays on the result (`content`) so the
 * caller can read the web citations.
 */
export async function runText<I>(deps: ClaudeDeps, run: TextRun<I>): Promise<CallResult<string>> {
  const built = run.task.build(run.input);
  const call: TaskCall<string> = {
    task: {
      id: built.taskId,
      version: run.task.version,
      features: run.task.features,
      effort: built.effort,
      maxTokensClass: built.maxTokensClass,
      output: { mode: run.task.outputMode === 'citations' ? 'citations' : 'plain' },
    },
    ctx: {
      userId: run.scope.userId,
      classGroupId: run.scope.classGroupId ?? null,
      subjectId: run.scope.subjectId ?? null,
      documentId: run.scope.documentId ?? null,
      nodeId: run.scope.nodeId ?? null,
      jobId: run.scope.jobId ?? null,
      feature: run.scope.feature,
      budgetClass: run.task.budget,
    },
    system: systemOf(built),
    messages: built.messages as unknown as TaskCall<string>['messages'],
    ...(built.tools ? { tools: built.tools as unknown as TaskCall<string>['tools'] } : {}),
    sources: sourcesOf(built.documents),
  };
  return callClaude(deps, withShortCache(call));
}
