import { test } from 'bun:test';
// Trilha (TRL-01, spec 14): open → prepare → answer through a whole chapter, with a wrong answer that is
// re-taught, the chapter test, mastery evidence, resume without new AI calls and the plan fallback.
import { TrailAnswerResSchema, TrailStateSchema } from '@studify/shared';
import { assert, assertEquals } from './assert.ts';
import { BOB, json, makeHarness, request, type FakeReply } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as trailOpen } from '../src/functions/trail-open.ts';
import { handler as trailPrepare } from '../src/functions/trail-prepare.ts';
import { handler as trailAnswer } from '../src/functions/trail-answer.ts';

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const page = [{ doc: 'D1', page_start: 12, page_end: 12 }];
const question = (stem: string) => ({
  stem,
  options: [
    { id: 'A', text: 'Na mitocôndria', rationale: 'Lá ocorre a respiração.' },
    { id: 'B', text: 'No cloroplasto', rationale: 'Correta: tem clorofila.' },
    { id: 'C', text: 'No núcleo', rationale: 'Guarda o DNA.' },
    { id: 'D', text: 'No vacúolo', rationale: 'Armazena água.' },
  ],
  correct: 'B',
  explanation: 'A clorofila fica no cloroplasto.',
  tip: 'Cloro = verde.',
  terms: [{ term: 'cloroplasto', definition: 'Organela onde ocorre a fotossíntese.' }],
  source_pages: page,
});
const lesson = (title: string) => ({ title, body: 'A **clorofila** capta luz.', terms: [{ term: 'clorofila', definition: 'Pigmento verde que capta luz.' }], source_pages: page });

/** Answers by task, recognised from the prompt text. */
function byTask(params: Record<string, unknown>, planReply: unknown): FakeReply {
  const text = JSON.stringify(params.messages) + JSON.stringify(params.system);
  if (text.includes('monte a trilha')) return reply(planReply);
  if (text.includes('Escreva o teste do capítulo')) return reply({ questions: [1, 2, 3, 4].map((n) => ({ ...question(`Teste ${n}`), concept_key: 'C1' })) });
  if (text.includes('reexplica o conceito')) return reply({ lesson: lesson('Outro jeito'), question: question('De novo: onde?') });
  return reply({ lesson: lesson('Clorofila'), questions: [question('Onde fica a clorofila?'), question('Qual organela é verde?'), question('Reserva')] });
}

const PLAN = { goal: 'Explicar como as plantas produzem energia.', chapters: [{ topic_key: 'T1', why: 'É o começo de tudo.', concept_keys: ['C1'] }] };

test('trail: plan, lesson, wrong answer re-taught, chapter test, completion', async () => {
  const h = makeHarness((params) => byTask(params, PLAN));
  await seedWorld(h);
  let n = 10;
  const call = async (fn: typeof trailOpen, name: string, body: unknown, token?: string) => {
    const res = await fn(request(name, { body, idem: v7(n++), ...(token ? { token } : {}) }), h.deps);
    return { status: res.status, body: await json(res) };
  };

  // 1. Open: the plan is made, the first step still needs content.
  const opened = await call(trailOpen, 'trail-open', { subject_id: IDS.subject });
  assertEquals(opened.status, 200, JSON.stringify(opened.body));
  const s0 = TrailStateSchema.parse(opened.body);
  assertEquals(s0.goal, PLAN.goal);
  assertEquals(s0.chapters.map((c) => c.title), ['Fotossíntese']);
  assertEquals(s0.chapters[0]!.why, 'É o começo de tudo.');
  assertEquals(s0.preparing, true);
  assertEquals(s0.step, null);
  assertEquals(h.claude.calls.length, 1);
  const trailId = s0.trail_id;

  // Opening again resumes: no second plan.
  await call(trailOpen, 'trail-open', { subject_id: IDS.subject });
  assertEquals(h.claude.calls.length, 1);

  // 2. Prepare: the lesson and its questions; the chapter test is the next lookahead.
  const prepared = TrailStateSchema.parse((await call(trailPrepare, 'trail-prepare', { trail_id: trailId })).body);
  assertEquals(prepared.step?.kind, 'lesson');
  assert(prepared.step?.kind === 'lesson' && prepared.step.body.includes('clorofila'));
  assertEquals(prepared.step?.terms[0]?.term, 'clorofila');
  assertEquals(prepared.step?.source_pages, [{ document_id: IDS.doc, page_start: 12, page_end: 12 }]);
  assertEquals(prepared.prefetch, true);
  const lessonId = prepared.step!.id;

  // 3. Read the lesson: the first question comes, without its answer.
  const read = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: lessonId, response: null })).body);
  assertEquals(read.feedback, null);
  assertEquals(read.state.step?.kind, 'question');
  assert(!JSON.stringify(read.state).includes('rationale') && !JSON.stringify(read.state).includes('"correct"'), 'the answer never reaches the app before answering');
  const q1 = read.state.step!.id;

  // 4. Wrong answer: feedback that teaches, evidence 0, and the re-teaching needs content.
  const wrong = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: q1, response: 'A' })).body);
  assertEquals(wrong.feedback?.correct, false);
  assertEquals(wrong.feedback?.correct_option, 'B');
  assertEquals(wrong.feedback?.rationales.find((r) => r.id === 'A')?.rationale, 'Lá ocorre a respiração.');
  assertEquals(wrong.state.preparing, true);
  const evidence = h.db.rows('mastery_evidence');
  assertEquals(evidence.length, 1);
  assertEquals(evidence[0]!.source, 'trail');
  assertEquals(evidence[0]!.outcome, 0);
  assertEquals(evidence[0]!.node_id, IDS.concept);
  assert(h.enqueued.some((e) => e.queue === 'mastery.recompute'));

  // Answering the same step again changes nothing.
  const again = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: q1, response: 'B' })).body);
  assertEquals(again.feedback?.correct, false);
  assertEquals(h.db.rows('mastery_evidence').length, 1);

  // 5. Re-teaching: another explanation, then a fresh question on the same point.
  const remedial = TrailStateSchema.parse((await call(trailPrepare, 'trail-prepare', { trail_id: trailId })).body);
  assertEquals(remedial.step?.purpose, 'remedial_lesson');
  const rq = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: remedial.step!.id, response: null })).body);
  assertEquals(rq.state.step?.purpose, 'remedial_question');
  const q2 = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: rq.state.step!.id, response: 'B' })).body);
  assertEquals(q2.feedback?.correct, true);
  assertEquals(q2.state.step?.purpose, 'practice');

  // 6. Second right answer clears the concept; the chapter test is next.
  const cleared = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: q2.state.step!.id, response: 'B' })).body);
  assertEquals(cleared.state.phase, 'checkpoint');
  assertEquals(cleared.state.preparing, true);
  assertEquals(cleared.state.chapters[0]!.concepts[0]!.state, 'cleared');

  const test1 = TrailStateSchema.parse((await call(trailPrepare, 'trail-prepare', { trail_id: trailId })).body);
  assertEquals(test1.step?.purpose, 'checkpoint');
  assert(test1.step?.kind === 'question' && test1.step.position?.index === 1 && test1.step.position.total === 4);

  // 7. All right: the chapter (and here the whole path) is done.
  let last = test1;
  let res: ReturnType<typeof TrailAnswerResSchema.parse> | null = null;
  for (let i = 0; i < 4; i++) {
    res = TrailAnswerResSchema.parse((await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: last.step!.id, response: 'B' })).body);
    last = res.state;
  }
  assertEquals(res!.checkpoint_result, { round: 1, correct: 4, total: 4, passed: true });
  assertEquals(res!.chapter_done?.title, 'Fotossíntese');
  assertEquals(res!.chapter_done?.next_title, null);
  assertEquals(res!.state.status, 'completed');
  assertEquals(res!.state.progress, 1);
  // The spare practice question was discarded with the chapter.
  assert(h.db.rows('trail_steps').some((s) => s.status === 'discarded'));
  assertEquals(h.claude.calls.length, 4); // plan, lesson, re-teaching, chapter test

  // Another student cannot touch this trail.
  const bob = await call(trailPrepare, 'trail-prepare', { trail_id: trailId }, BOB.jwt);
  assertEquals(bob.status, 404);
  const bobAnswer = await call(trailAnswer, 'trail-answer', { trail_id: trailId, step_id: lessonId, response: null }, BOB.jwt);
  assertEquals(bobAnswer.status, 404);
});

test('trail: an unusable plan falls back to the outline order', async () => {
  const h = makeHarness((params) => byTask(params, { nope: true }));
  await seedWorld(h);
  const res = await trailOpen(request('trail-open', { body: { subject_id: IDS.subject }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 200);
  const state = TrailStateSchema.parse(await json(res));
  assertEquals(state.chapters.map((c) => c.topic_id), [IDS.topic]);
  assertEquals(state.goal, null);
  assertEquals(h.db.rows('trails')[0]!.prompt_version, null);
});

test('trail: a subject without ready topics cannot open a trail', async () => {
  const h = makeHarness(reply(PLAN));
  await seedWorld(h);
  h.db.tables.set('node_sources', []);
  const res = await trailOpen(request('trail-open', { body: { subject_id: IDS.subject }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 404);
  assertEquals(h.claude.calls.length, 0);
});
