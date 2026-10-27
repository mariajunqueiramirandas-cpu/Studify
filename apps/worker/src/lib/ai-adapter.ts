// Adapter from a @studify/prompts TaskDef (plus its Zod output schema) to the @studify/ai TaskCall
// that callClaude() takes. The prompt builders stay the source of truth for system text, messages
// and document labels; this file only reshapes them and keeps the document map for post-checks.
import { callClaude, type BudgetContext, type CallResult, type ClaudeDeps, type DocumentSlice, type SystemBlock, type TaskCall } from '@studify/ai';
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
  };
  const result = await callClaude(deps, call);
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
