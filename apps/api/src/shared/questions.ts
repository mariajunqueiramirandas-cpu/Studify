// Question generation for one topic (PRA-01.4, questions.more): the model writes questions, this module
// stores the ones that pass the shared payload schema. Shared by questions-generate-more and quiz-create's
// top-up step, so both produce the same rows.
import { getTask, topUpQuotas, type QuestionType as PromptQuestionType } from '@studify/prompts';
import { parseQuestionPayload, type QuestionType } from '@studify/shared';
import { callTask, unwrapResult } from './ai.ts';
import { budgetCtxFor } from './ctx.ts';
import type { SubjectRow } from './access.ts';
import type { Deps } from './deps.ts';
import { claudeDepsFor } from './deps.ts';
import { loadTopic, topicInput, topicSlices, type TopicBundle } from './topic.ts';

/** Renames the prompts' misconception key to the shared payload's id field (spec 05 §8.1). */
export function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key === 'misconception_concept_key' ? 'misconception_concept_id' : key] = normalizePayload(child);
    }
    return out;
  }
  return value;
}

export interface GeneratedQuestion {
  type: PromptQuestionType;
  stem: string;
  stimulus_md: string | null;
  explanation: string;
  bloom_level: string;
  difficulty: number;
  concept_keys: string[];
  source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
  payload: unknown;
}

export interface GenerateOptions {
  count?: number;
  enemStyle?: boolean;
  subject: SubjectRow;
  userId: string;
}

/** Generates and stores questions for a topic. Returns the ids of the rows written (invalid ones are dropped). */
export async function generateQuestionsForNode(
  deps: Deps,
  nodeId: string,
  options: GenerateOptions,
): Promise<string[]> {
  const bundle: TopicBundle = await loadTopic(deps.db, options.userId, nodeId);
  const { slices } = await topicSlices(deps, bundle);
  const existing = await deps.db
    .from('questions')
    .select('stem')
    .eq('node_id', nodeId)
    .eq('status', 'active')
    .is('deleted_at', null);
  if (existing.error) throw existing.error;
  const existingStems = (existing.data as Array<{ stem: string }>).map((r) => r.stem);

  const built = getTask('questions.more').build({
    topic: topicInput(bundle),
    slices,
    quotas: topUpQuotas({ quantitative: false }),
    existingStems,
    quantitative: false,
    contentLanguage: bundle.contentLanguage,
    languageSubject: bundle.languageSubject,
  });
  const result = await callTask(claudeDepsFor(deps), {
    built,
    taskId: 'questions.more',
    ctx: budgetCtxFor(options.subject, options.userId, 'PRA-01.4', 'user', { nodeId }),
  });
  const data = unwrapResult(result) as { questions: GeneratedQuestion[] };
  const docLabels = built.documents?.labels ?? {};
  const conceptIds = new Set(bundle.concepts.map((c) => c.id));

  const rows: Record<string, unknown>[] = [];
  for (const q of data.questions.slice(0, options.count ?? 10)) {
    const payload = normalizePayload(q.payload);
    let typed: unknown;
    try {
      typed = parseQuestionPayload(q.type as QuestionType, payload);
    } catch {
      continue; // off-schema for the shared contract: dropped (ai-pipeline §5.1)
    }
    rows.push({
      id: deps.newId(),
      subject_id: options.subject.id,
      node_id: nodeId,
      concept_ids: q.concept_keys.filter((k) => conceptIds.has(k)),
      type: q.type,
      stem: q.stem,
      stimulus: q.stimulus_md ? { markdown: q.stimulus_md } : null,
      payload: typed,
      explanation: q.explanation,
      bloom_level: q.bloom_level,
      difficulty: q.difficulty,
      source_pages: q.source_pages
        .filter((r) => docLabels[r.doc])
        .map((r) => ({ document_id: docLabels[r.doc], page_start: r.page_start, page_end: r.page_end })),
      origin: 'generated',
      has_math: /\$/.test(q.stem),
      prompt_version: getTask('questions.more').promptVersion,
      status: 'active',
      review_status: 'approved',
    });
  }
  if (rows.length === 0) return [];
  const inserted = await deps.db.from('questions').insert(rows);
  if (inserted.error) throw inserted.error;
  return rows.map((r) => r.id as string);
}

