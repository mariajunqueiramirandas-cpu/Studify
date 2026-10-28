// The Trilha's Claude calls (TRL-01; api §4.11): the chapter plan (planChapters, replan) and the content of the
// next step (generate). Kept apart from shared/trail.ts so the import graph shows exactly which functions reach a
// plain Claude call (ADR 0009): trail-open and trail-prepare run as jobs, trail-answer does not need to.
import {
  checkpointBlueprint,
  normalizeTrailPlan,
  type ProposedChapter,
  type SourcePage,
  type TrailChapter,
  type TrailNeed,
  type TrailOutlineTopic,
  type TrailStepPurpose,
} from '@studify/shared';
import { getTask, type DocumentMap } from '@studify/prompts';
import type { SubjectRow } from './access.ts';
import { callTask, unwrapResult } from './ai.ts';
import { budgetCtxFor } from './ctx.ts';
import { claudeDepsFor, type Deps } from './deps.ts';
import { loadTopic, topicSlices, type TopicBundle } from './topic.ts';
import { mapPages } from '../shared-p3/teaching.ts';
import { isQuestionPurpose, toView, type LessonContent, type Outline, type QuestionContent, type StepRow, type TrailRow } from './trail.ts';

const FEATURE = 'TRL-01';
function keyMaps(topics: readonly TrailOutlineTopic[]) {
  const topicKey = new Map<string, string>();
  const conceptKey = new Map<string, string>();
  const fromKey = new Map<string, string>();
  let c = 0;
  topics.forEach((t, i) => {
    topicKey.set(t.id, `T${i + 1}`);
    fromKey.set(`T${i + 1}`, t.id);
    for (const concept of t.concepts) {
      c += 1;
      conceptKey.set(concept.id, `C${c}`);
      fromKey.set(`C${c}`, concept.id);
    }
  });
  return { topicKey, conceptKey, fromKey };
}

interface PlanOut {
  goal: string;
  chapters: Array<{ topic_key: string; why: string; concept_keys: string[] }>;
}

/**
 * The path for `topics` after the chapters already fixed (spec 14 §8.1). The model proposes the order; the
 * outline order is the fallback when the call fails, so the path never waits on AI to exist.
 */
export async function planChapters(
  deps: Deps,
  userId: string,
  subject: SubjectRow,
  outline: Outline,
  topics: readonly TrailOutlineTopic[],
  doneTitles: readonly string[],
): Promise<{ chapters: TrailChapter[]; goal: string | null; promptVersion: string | null }> {
  if (topics.length === 0) return { chapters: [], goal: null, promptVersion: null };
  const sorted = [...topics].sort((a, b) => a.order - b.order);
  const { topicKey, conceptKey, fromKey } = keyMaps(sorted);
  const keyOf = (id: string) => topicKey.get(id) ?? conceptKey.get(id);

  const units: Array<{ title: string | null; topics: Array<Record<string, unknown>> }> = [];
  for (const t of sorted) {
    const node = outline.nodes.get(t.id);
    const parent = node?.parent_id ? outline.nodes.get(node.parent_id) : undefined;
    const unitTitle = parent && parent.kind === 'unit' ? parent.title : null;
    if (units.at(-1)?.title !== unitTitle || units.length === 0) units.push({ title: unitTitle, topics: [] });
    units.at(-1)!.topics.push({
      key: topicKey.get(t.id),
      title: t.title,
      summary: node?.summary ?? null,
      objectives: node?.learning_objectives ?? [],
      concepts: [...t.concepts].sort((a, b) => a.order - b.order).map((c) => ({ key: conceptKey.get(c.id), title: c.title })),
    });
  }
  const needs = new Map<string, Set<string>>();
  for (const e of outline.prerequisites) {
    const a = keyOf(e.nodeId);
    const b = keyOf(e.prerequisiteId);
    if (a && b && a !== b) needs.set(a, (needs.get(a) ?? new Set()).add(b));
  }

  const task = getTask('trail.plan');
  try {
    const built = task.build({
      subjectName: subject.name,
      units,
      prerequisites: [...needs.entries()].map(([key, set]) => ({ key, needs: [...set].sort() })),
      alreadyDone: doneTitles,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'trail.plan',
      ctx: budgetCtxFor(subject, userId, FEATURE, 'user'),
      choices: { topic: [...topicKey.values()], concept: [...conceptKey.values()] },
    });
    const out = unwrapResult(result) as PlanOut;
    const proposed: ProposedChapter[] = out.chapters
      .map((ch) => ({ topicId: fromKey.get(ch.topic_key) ?? '', why: ch.why, conceptIds: ch.concept_keys.map((k) => fromKey.get(k) ?? '') }))
      .filter((ch) => ch.topicId);
    return { chapters: normalizeTrailPlan(proposed, sorted, outline.prerequisites), goal: out.goal, promptVersion: task.promptVersion };
  } catch (err) {
    // Budget, refusal or an unusable answer: the outline order still makes a valid path.
    console.warn('[trail] plan fallback', err instanceof Error ? err.message : err);
    return { chapters: normalizeTrailPlan([], sorted, outline.prerequisites), goal: null, promptVersion: null };
  }
}

/**
 * After the outline changed (new material, edits, "não cai na prova"): finished chapters and the one in progress
 * keep their place, with their concept lists refreshed; everything else is planned again.
 */
export async function replan(deps: Deps, userId: string, subject: SubjectRow, trail: TrailRow, outline: Outline, startedTopicIds: ReadonlySet<string>) {
  const live = new Map(outline.topics.map((t) => [t.id, t]));
  const fixedCount = Math.min(trail.plan.length, trail.chapter_index + (startedTopicIds.has(trail.plan[trail.chapter_index]?.topicId ?? '') ? 1 : 0));
  const fixed: TrailChapter[] = [];
  let doneCount = 0;
  trail.plan.slice(0, fixedCount).forEach((ch, i) => {
    const topic = live.get(ch.topicId);
    if (!topic) return;
    const own = [...topic.concepts].sort((a, b) => a.order - b.order).map((c) => c.id);
    const conceptIds = own.length ? [...ch.conceptIds.filter((id) => own.includes(id)), ...own.filter((id) => !ch.conceptIds.includes(id))] : [topic.id];
    fixed.push({ ...ch, conceptIds });
    if (i < trail.chapter_index) doneCount += 1;
  });
  const rest = outline.topics.filter((t) => !fixed.some((f) => f.topicId === t.id));
  const planned = await planChapters(deps, userId, subject, outline, rest, fixed.map((f) => live.get(f.topicId)!.title));
  return { plan: [...fixed, ...planned.chapters], chapterIndex: doneCount, goal: planned.goal ?? trail.goal, promptVersion: planned.promptVersion ?? trail.prompt_version };
}
interface LessonOut {
  lesson: { title: string; body: string; terms: LessonContent['terms']; source_pages: Array<{ doc: string; page_start: number; page_end: number }> };
  questions: Array<Omit<QuestionContent, never> & { source_pages: Array<{ doc: string; page_start: number; page_end: number }> }>;
}
interface RemediationOut {
  lesson: LessonOut['lesson'];
  question: LessonOut['questions'][number];
}
interface CheckpointOut {
  questions: Array<LessonOut['questions'][number] & { concept_key: string }>;
}

function questionContent(q: LessonOut['questions'][number]): QuestionContent {
  return { stem: q.stem, options: q.options, correct: q.correct, explanation: q.explanation, tip: q.tip, terms: q.terms };
}

/** Titles of the concepts the path taught before `conceptId` (or up to it, `inclusive`), the last 12. */
function taughtBefore(trail: TrailRow, conceptId: string, outline: Outline, inclusive = false): string[] {
  const order = trail.plan.flatMap((ch) => ch.conceptIds);
  const idx = order.indexOf(conceptId);
  return order
    .slice(0, Math.max(0, idx + (inclusive ? 1 : 0)))
    .slice(-12)
    .map((id) => outline.nodes.get(id)?.title)
    .filter((t): t is string => !!t);
}

function conceptInput(bundle: TopicBundle, conceptId: string) {
  const concept = bundle.concepts.find((c) => c.id === conceptId);
  if (concept) return { key: concept.id, title: concept.title, summary: concept.summary, keyTerms: concept.key_terms ?? [] };
  // A topic without concepts is taught as one concept: itself.
  return { key: bundle.nodeId, title: bundle.title, summary: bundle.summary, keyTerms: bundle.keyTerms };
}

function topicPromptInput(bundle: TopicBundle) {
  return {
    title: bundle.title,
    summary: bundle.summary,
    objectives: bundle.objectives,
    concepts: bundle.concepts.map((c) => ({ key: c.id, title: c.title, keyTerms: c.key_terms ?? [], formulas: c.formulas ?? [] })),
  };
}

interface NewStep {
  concept_id: string;
  purpose: TrailStepPurpose;
  round: number;
  for_step_id: string | null;
  content: LessonContent | QuestionContent;
  source_pages: SourcePage[];
}

/**
 * Generates the content one need asks for and stores it as `ready` steps (spec 14 §7). The topic's PDF pages
 * are the cached prefix, so every step of a chapter reuses them.
 */
export async function generate(
  deps: Deps,
  userId: string,
  subject: SubjectRow,
  trail: TrailRow,
  chapterIndex: number,
  need: TrailNeed,
  steps: readonly StepRow[],
  outline: Outline,
): Promise<void> {
  const chapter = trail.plan[chapterIndex];
  if (!chapter) return;
  const bundle = await loadTopic(deps.db, userId, chapter.topicId);
  const { slices } = await topicSlices(deps, bundle);
  const base = {
    topic: topicPromptInput(bundle),
    slices,
    contentLanguage: bundle.contentLanguage,
    languageSubject: bundle.languageSubject,
  };
  const ctx = budgetCtxFor(subject, userId, FEATURE, 'user', { nodeId: chapter.topicId });
  const chapterSteps = steps.filter((s) => s.topic_id === chapter.topicId);
  const fresh: NewStep[] = [];
  let promptVersion: string;
  let documents: DocumentMap;

  if (need.kind === 'teach') {
    const task = getTask('trail.lesson');
    const built = task.build({ ...base, concept: conceptInput(bundle, need.conceptId), taughtBefore: taughtBefore(trail, need.conceptId, outline) });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.lesson', ctx })) as LessonOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    fresh.push({ concept_id: need.conceptId, purpose: 'lesson', round: 0, for_step_id: null, content: { title: out.lesson.title, body: out.lesson.body, terms: out.lesson.terms }, source_pages: mapPages(out.lesson.source_pages, documents) });
    for (const q of out.questions) fresh.push({ concept_id: need.conceptId, purpose: 'practice', round: 0, for_step_id: null, content: questionContent(q), source_pages: mapPages(q.source_pages, documents) });
  } else if (need.kind === 'remediate') {
    const wrong = steps.find((s) => s.id === need.forStepId);
    if (!wrong) return;
    const q = wrong.content as QuestionContent;
    const chosen = q.options.find((o) => o.id === wrong.response);
    const right = q.options.find((o) => o.id === q.correct);
    const task = getTask('trail.remediate');
    const built = task.build({
      ...base,
      concept: conceptInput(bundle, need.conceptId),
      taughtBefore: taughtBefore(trail, need.conceptId, outline),
      mistake: { stem: q.stem, chosen: chosen?.text ?? '(sem resposta)', correct: right?.text ?? q.correct, explanation: q.explanation, inChapterTest: wrong.purpose === 'checkpoint' },
      askedStems: chapterSteps.filter((s) => s.concept_id === need.conceptId && isQuestionPurpose(s.purpose)).map((s) => (s.content as QuestionContent).stem).slice(-8),
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.remediate', ctx })) as RemediationOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    fresh.push({ concept_id: need.conceptId, purpose: 'remedial_lesson', round: need.round, for_step_id: wrong.id, content: { title: out.lesson.title, body: out.lesson.body, terms: out.lesson.terms }, source_pages: mapPages(out.lesson.source_pages, documents) });
    fresh.push({ concept_id: need.conceptId, purpose: 'remedial_question', round: need.round, for_step_id: wrong.id, content: questionContent(out.question), source_pages: mapPages(out.question.source_pages, documents) });
  } else {
    const blueprint = checkpointBlueprint(chapter, chapterSteps.map(toView));
    const keys = new Map(blueprint.map((b, i) => [`C${i + 1}`, b.conceptId]));
    const keyOf = new Map([...keys.entries()].map(([k, id]) => [id, k]));
    const weak = new Set(chapterSteps.filter((s) => s.correct === false).map((s) => s.concept_id));
    const task = getTask('trail.checkpoint');
    const built = task.build({
      ...base,
      taughtBefore: taughtBefore(trail, chapter.conceptIds.at(-1)!, outline, true),
      blueprint: blueprint.map((b) => ({ key: keyOf.get(b.conceptId)!, title: outline.nodes.get(b.conceptId)?.title ?? bundle.title, count: b.count, weak: weak.has(b.conceptId) })),
      askedStems: chapterSteps.filter((s) => isQuestionPurpose(s.purpose)).map((s) => (s.content as QuestionContent).stem).slice(-20),
      round: need.round,
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.checkpoint', ctx, choices: { concept: [...keys.keys()] } })) as CheckpointOut;
    documents = built.documents ?? { labels: {}, allowedPages: {} };
    promptVersion = task.promptVersion;
    const fallbackConcept = blueprint[0]?.conceptId ?? chapter.conceptIds[0]!;
    for (const q of out.questions) {
      fresh.push({ concept_id: keys.get(q.concept_key) ?? fallbackConcept, purpose: 'checkpoint', round: need.round, for_step_id: null, content: questionContent(q), source_pages: mapPages(q.source_pages, documents) });
    }
  }

  // Creation order continues after the newest step (re-read: another request may have added steps meanwhile).
  const last = await deps.db.from('trail_steps').select('created_seq').eq('trail_id', trail.id).order('created_seq', { ascending: false }).limit(1);
  if (last.error) throw last.error;
  let seq = ((last.data as Array<{ created_seq: number }>)[0]?.created_seq ?? 0) + 1;
  const rows = fresh.map((s) => ({
    id: deps.newId(),
    trail_id: trail.id,
    user_id: userId,
    chapter_index: chapterIndex,
    topic_id: chapter.topicId,
    status: 'ready',
    prompt_version: promptVersion,
    created_seq: seq++,
    served_seq: null,
    response: null,
    correct: null,
    answered_at: null,
    ...s,
  }));
  const inserted = await deps.db.from('trail_steps').insert(rows);
  if (inserted.error) throw inserted.error;
}
