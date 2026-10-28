// Adapter from @studify/prompts (BuiltPrompt) to @studify/ai (TaskCall), plus the call helpers that
// turn a CallResult into the API result. The prompts package owns the text; the ai package owns the
// budget gate, stop_reason handling, validation, citation mapping and usage rows (ai-pipeline §2.5).
import type { ZodType } from 'zod';
import { callClaude, choicesFromPages, streamClaude } from '@studify/ai';
import type { BudgetContext, CallResult, Choices, ClaudeDeps, DocumentSlice, MappedCitation, StreamEvent, TaskCall, TaskDef as AiTaskDef } from '@studify/ai';
import { ApiFailure } from '@studify/shared';
import {
  checkPageRefs,
  getTask,
  RemediationCard,
  RouteNodes,
  ScopeMatch,
  SelectionCard,
  ShortAnswerGrade,
  SingleQuestion,
  TopicCards,
  TopicQuestions,
  TutorCard,
  GlossaryTerms,
  CaptureUnderstanding,
  HintLadder,
  FaithfulTranscription,
  EssayQuestionGrade,
  FirstWrongStep,
  LucasPlanSchema,
  LucasTurnSchema,
  ModerationVerdict,
  EnemGeneratedItems,
  EssayThemePromptOut,
  ArgumentRoundFeedback,
  ThesisFeedback,
  ArgumentSummary,
  ArgumentThemes,
  VisualDraft,
  MnemonicOptions,
  ContributionReview,
  PeerQuestionValidation,
  type AnyTaskDef,
  type BuiltPrompt,
  type PromptMessage,
} from '@studify/prompts';

/** Output schemas by task id (the prompts registry exposes JSON Schema, the SDK path needs Zod). */
export const OUTPUT_SCHEMAS: Readonly<Record<string, ZodType>> = {
  'cards.generate': TopicCards,
  'cards.more': TopicCards,
  'cards.fromSelection': SelectionCard,
  'cards.remediation': RemediationCard,
  'questions.generate': TopicQuestions,
  'questions.more': TopicQuestions,
  'questions.variant': SingleQuestion,
  'grade.shortAnswer': ShortAnswerGrade,
  'scope.match': ScopeMatch,
  'tutor.route': RouteNodes,
  'tutor.toCard': TutorCard,
  'glossary.define': GlossaryTerms,
  // Phase 3
  'camera.understand': CaptureUnderstanding,
  'camera.matchTiebreak': RouteNodes,
  'camera.solveLadder': HintLadder,
  'camera.transcribe': FaithfulTranscription,
  'grade.essayQuestion': EssayQuestionGrade,
  'problems.firstWrongStep': FirstWrongStep,
  'lucas.plan': LucasPlanSchema,
  'lucas.turn': LucasTurnSchema,
  // Phase 4
  'moderation.classify': ModerationVerdict,
  'enem.question.generate': EnemGeneratedItems,
  'essay.themePrompt': EssayThemePromptOut,
  'argument.feedback': ArgumentRoundFeedback,
  'argument.thesis': ThesisFeedback,
  'argument.summary': ArgumentSummary,
  'argument.themes': ArgumentThemes,
  // Phase 5
  'visual.generate': VisualDraft,
  'mnemonics.suggest': MnemonicOptions,
  'divide.review': ContributionReview,
  'peer.validate': PeerQuestionValidation,
};

export function taskDef(id: string): AnyTaskDef {
  return getTask(id);
}

/**
 * Sources of the document blocks this build adds, in request order. Replayed history comes first in the
 * messages and its blocks are described by the caller's historySources, so only the last
 * |built.documents.labels| document blocks are new (their labels restart at D1 in every build).
 */
export function sourcesFromBuilt(built: BuiltPrompt): DocumentSlice[] {
  const docs = built.documents;
  const blocks: Array<{ title: string }> = [];
  for (const message of built.messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) if (block.type === 'document') blocks.push(block);
  }
  const fresh = docs ? Object.keys(docs.labels).length : 0;
  if (fresh > blocks.length) throw new ApiFailure('internal_error');
  return blocks.slice(blocks.length - fresh).map((block) => {
    const label = /Documento (D\d+)/.exec(block.title)?.[1];
    if (!label || !docs || docs.labels[label] === undefined) throw new ApiFailure('internal_error');
    return { id: label, documentId: docs.labels[label], title: label, pages: [...(docs.allowedPages[label] ?? [])] };
  });
}

/** Walks the output for `{doc, page_start, page_end}` references and checks them against what was sent. */
export function collectPageRefs(value: unknown, out: Array<{ doc: string; page_start: number; page_end: number }> = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPageRefs(item, out);
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.doc === 'string' && typeof obj.page_start === 'number' && typeof obj.page_end === 'number') {
      out.push({ doc: obj.doc, page_start: obj.page_start, page_end: obj.page_end });
    }
    for (const child of Object.values(obj)) collectPageRefs(child, out);
  }
  return out;
}

export interface PromptCall<T> {
  built: BuiltPrompt;
  taskId: string;
  ctx: BudgetContext;
  /** Extra sources that precede the new document blocks (tutor history replays earlier documents). */
  historySources?: DocumentSlice[];
  /** Estimate overrides (rare). */
  estimate?: { inputTokens?: number; outputTokens?: number };
  /** Set for structured tasks. */
  structured?: boolean;
  /** Pages sent as text rather than document blocks (doc label → pages) that the output may also cite. */
  textPages?: Record<string, number[]>;
  messages?: PromptMessage[];
  /** Keys the output may use beyond labels and pages (e.g. the topic's concept keys). */
  choices?: Choices;
}

/** Converts a built prompt into the TaskCall the ai wrapper consumes. */
export function toTaskCall<T>(p: PromptCall<T>): TaskCall<T> {
  const def = taskDef(p.taskId);
  const built = p.built;
  const schema = OUTPUT_SCHEMAS[p.taskId];
  const newSources = sourcesFromBuilt(built);
  const pages = { ...(p.textPages ?? {}), ...(built.documents?.allowedPages ?? {}) };
  const output: AiTaskDef<T>['output'] =
    def.outputMode === 'structured'
      ? { mode: 'structured', schema: schema as unknown as ZodType<T> }
      : { mode: def.outputMode as 'citations' | 'plain' };
  const task: AiTaskDef<T> = {
    id: built.taskId,
    version: def.version,
    features: def.features,
    effort: built.effort,
    maxTokensClass: built.maxTokensClass,
    output,
    postValidate: (data: T) => {
      const refs = collectPageRefs(data);
      const issues = checkPageRefs(refs, pages);
      return issues.length > 0 ? issues.slice(0, 3).join('; ') : null;
    },
  };
  const sources = [...(p.historySources ?? []), ...newSources];
  const system = built.system.map((block) => ({
    text: block.text,
    ...(block.cache_control ? { cacheTtl: block.cache_control.ttl } : {}),
  }));
  return {
    task,
    ctx: p.ctx,
    system,
    // Labels and pages the output may cite, as schema enums: an invented page cannot be written.
    choices: { ...choicesFromPages(pages), ...(p.choices ?? {}) },
    messages: (p.messages ?? built.messages) as unknown as TaskCall<T>['messages'],
    ...(built.tools ? { tools: built.tools as unknown as TaskCall<T>['tools'] } : {}),
    sources,
    ...(p.estimate ? { estimate: p.estimate } : {}),
  };
}

/** Maps a non-ok CallResult to the API error (ai-pipeline §2.4, §5.1, §10.1). */
export function unwrapResult<T>(result: CallResult<T>): T {
  switch (result.status) {
    case 'ok':
      return result.data;
    case 'refused':
      throw new ApiFailure('ai_refused');
    case 'truncated':
      throw new ApiFailure('ai_unavailable', { message: 'A resposta ficou grande demais. Tenta de novo com menos itens.' });
    case 'invalid_output':
      throw new ApiFailure('ai_unavailable', { message: 'Não consegui gerar isso agora. Tenta de novo.' });
  }
}

export function callTask<T>(deps: ClaudeDeps, p: PromptCall<T>): Promise<CallResult<T>> {
  return callClaude(deps, toTaskCall(p));
}

/** Citation to the storage shape (citations.ts Citation): valid page locations only, with text offsets. */
export function citationsForStorage(citations: readonly MappedCitation[]) {
  return citations
    .filter((c) => c.valid && c.pageStart !== null && c.pageEnd !== null && c.documentId !== null)
    .map((c) => ({
      start: c.textStart ?? 0,
      end: c.textEnd ?? c.textStart ?? 0,
      document_id: c.documentId as string,
      page_start: c.pageStart as number,
      page_end: c.pageEnd as number,
      cited_text: c.citedText,
    }));
}

export interface OpenedStream<T> {
  /** The first event has arrived: the budget gate passed and the model answered. */
  first: StreamEvent;
  rest: AsyncIterator<StreamEvent>;
  result: Promise<CallResult<T>>;
}

/**
 * Starts a streamed call and waits for its first event. A budget refusal, a configuration problem or
 * a transient failure therefore throws here, before the SSE response is opened (the caller then
 * answers with a normal JSON error and the right HTTP status).
 */
export async function openStream<T>(deps: ClaudeDeps, call: TaskCall<T>): Promise<OpenedStream<T>> {
  const handle = streamClaude(deps, call);
  const rest = handle.events[Symbol.asyncIterator]();
  const first = await rest.next();
  if (first.done) {
    const result = await handle.result;
    return { first: { type: 'end', status: result.status }, rest, result: Promise.resolve(result) };
  }
  return { first: first.value, rest, result: handle.result };
}

export async function nextEvent(session: OpenedStream<unknown>): Promise<StreamEvent | null> {
  const next = await session.rest.next();
  return next.done ? null : next.value;
}
