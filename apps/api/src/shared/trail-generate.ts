// The Trilha's Claude calls (TRL-01; api §4.11), for what the content written ahead does not cover (ADR 0011): a
// concept whose lesson is not written yet (a material processed before the Trilha was written ahead, or a call that
// failed then), a re-teaching once a concept's fresh questions are used up, a chapter-test round the shared test
// questions cannot fill. Kept apart from shared/trail.ts so the import graph shows exactly which functions reach a
// plain Claude call: only trail-prepare does.
import { checkpointBlueprint, taughtBeforeIn, type TrailNeed } from '@studify/shared';
import { getTask, type DocumentMap } from '@studify/prompts';
import type { SubjectRow } from './access.ts';
import { callTask, unwrapResult } from './ai.ts';
import { budgetCtxFor } from './ctx.ts';
import { claudeDepsFor, type Deps } from './deps.ts';
import { loadTopic, topicSlices, type TopicBundle } from './topic.ts';
import { mapPages } from '../shared-p3/teaching.ts';
import { isQuestionPurpose, stepRows, toView, type BankLesson, type BankQuestion, type NewStep, type Outline, type QuestionContent, type StepRow, type TrailRow } from './trail.ts';

const FEATURE = 'TRL-01';

type ModelPages = Array<{ doc: string; page_start: number; page_end: number }>;
interface ModelLesson {
  title: string;
  body: string;
  terms: BankLesson['terms'];
  source_pages: ModelPages;
}
type ModelQuestion = QuestionContent & { source_pages: ModelPages };
interface LessonOut {
  lesson: ModelLesson;
  questions: ModelQuestion[];
}
interface RemediationOut {
  lesson: ModelLesson;
  question: ModelQuestion;
}
interface CheckpointOut {
  questions: Array<ModelQuestion & { concept_key: string }>;
}

const bankLesson = (l: ModelLesson, documents: DocumentMap): BankLesson => ({ title: l.title, body: l.body, terms: l.terms, source_pages: mapPages(l.source_pages, documents) });
const bankQuestion = (q: ModelQuestion, documents: DocumentMap): BankQuestion => ({
  stem: q.stem,
  options: q.options,
  correct: q.correct,
  explanation: q.explanation,
  tip: q.tip,
  terms: q.terms,
  source_pages: mapPages(q.source_pages, documents),
});

/** Titles of the concepts this student's path taught before `conceptId` (or up to it, `inclusive`). */
function taughtBefore(trail: TrailRow, conceptId: string, outline: Outline, inclusive = false): string[] {
  return taughtBeforeIn(trail.plan.flatMap((ch) => ch.conceptIds), conceptId, (id) => outline.nodes.get(id)?.title, inclusive);
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

/**
 * Writes the content one need asks for (spec 14 §7). A lesson goes into the subject's shared content
 * (trail_concept_content), like the lessons written ahead: this student's trail copies it from there, and so does
 * every classmate who reaches the concept later, without another call. A re-teaching or a chapter test aimed at this
 * student's answers is stored as their own `ready` steps. The topic's PDF pages are the cached prefix.
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
  const documentsOf = (built: { documents?: DocumentMap }): DocumentMap => built.documents ?? { labels: {}, allowedPages: {} };

  if (need.kind === 'teach') {
    const task = getTask('trail.lesson');
    const built = task.build({ ...base, concept: conceptInput(bundle, need.conceptId), taughtBefore: taughtBefore(trail, need.conceptId, outline) });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'trail.lesson', ctx })) as LessonOut;
    const documents = documentsOf(built);
    // A classmate's call (or the material's) that finished first keeps its version.
    const stored = await deps.db.from('trail_concept_content').upsert(
      {
        concept_id: need.conceptId,
        topic_id: chapter.topicId,
        subject_id: subject.id,
        lesson: bankLesson(out.lesson, documents),
        practice: out.questions.map((q) => bankQuestion(q, documents)),
        prompt_version: task.promptVersion,
      },
      { onConflict: 'concept_id', ignoreDuplicates: true },
    );
    if (stored.error) throw stored.error;
    return;
  }

  const fresh: NewStep[] = [];
  if (need.kind === 'remediate') {
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
    const documents = documentsOf(built);
    const stepBase = { concept_id: need.conceptId, round: need.round, for_step_id: wrong.id, prompt_version: task.promptVersion };
    const lesson = bankLesson(out.lesson, documents);
    const question = bankQuestion(out.question, documents);
    fresh.push({ ...stepBase, purpose: 'remedial_lesson', content: { title: lesson.title, body: lesson.body, terms: lesson.terms }, source_pages: lesson.source_pages });
    fresh.push({ ...stepBase, purpose: 'remedial_question', content: { stem: question.stem, options: question.options, correct: question.correct, explanation: question.explanation, tip: question.tip, terms: question.terms }, source_pages: question.source_pages });
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
    const documents = documentsOf(built);
    const fallbackConcept = blueprint[0]?.conceptId ?? chapter.conceptIds[0]!;
    for (const q of out.questions) {
      const question = bankQuestion(q, documents);
      fresh.push({
        concept_id: keys.get(q.concept_key) ?? fallbackConcept,
        purpose: 'checkpoint',
        round: need.round,
        for_step_id: null,
        content: { stem: question.stem, options: question.options, correct: question.correct, explanation: question.explanation, tip: question.tip, terms: question.terms },
        source_pages: question.source_pages,
        prompt_version: task.promptVersion,
      });
    }
  }

  // Creation order continues after the newest step, re-read: steps copied from the shared content meanwhile (another
  // request of this student) took the next numbers, so a collision reads them again once.
  for (let attempt = 0; ; attempt += 1) {
    const last = await deps.db.from('trail_steps').select('created_seq').eq('trail_id', trail.id).order('created_seq', { ascending: false }).limit(1);
    if (last.error) throw last.error;
    const inserted = await deps.db.from('trail_steps').insert(stepRows(deps, trail, chapterIndex, fresh, (last.data as Array<{ created_seq: number }>)[0]?.created_seq ?? 0));
    if (!inserted.error) return;
    if (inserted.error.code !== '23505' || attempt >= 1) throw inserted.error;
  }
}
