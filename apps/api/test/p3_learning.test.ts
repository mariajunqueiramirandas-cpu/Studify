import { test } from 'bun:test';
// Ensine o Lucas (INT-02): the plan stays server-side, the lesson resumes instead of paying twice, turns are
// replayed append-only, and a lesson ended before turn 4 is "too short". Essay grading (PRA-07): the score
// comes from the rubric in code, and a low score goes to the Caderno. First wrong step (PRA-08.5).
import { assert, assertEquals } from './assert.ts';
import { BOB, json, makeHarness, parseSse, request, type FakeReply } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as teachingStart } from '../src/functions/teaching-start.ts';
import { handler as teachingTurn } from '../src/functions/teaching-turn.ts';
import { handler as teachingFinish } from '../src/functions/teaching-finish.ts';
import { handler as gradeEssay, scoreEssay } from '../src/functions/grade-essay.ts';
import { handler as checkWork } from '../src/functions/problem-check-work.ts';

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const PLAN = {
  key_concepts: [
    { id: 'k1', statement: 'A clorofila capta luz.', concept_key: 'C1', source_pages: [{ doc: 'D1', page_start: 12, page_end: 12 }] },
    { id: 'k2', statement: 'A fotossíntese produz glicose.', concept_key: null, source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }] },
  ],
  misconceptions: [
    {
      id: 'm1',
      lucas_belief: 'A planta come terra para crescer.',
      correct_concept: 'A massa vem do CO2 do ar.',
      fix_criteria: ['menciona CO2'],
      trigger: 'early',
      source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }],
    },
  ],
  naive_questions: ['Por que as folhas são verdes?', 'A planta respira?'],
};

function turn(text: string, fixed = false): FakeReply {
  return reply({
    lucas_reply: text,
    safety: 'ok',
    evaluation: {
      misconception_updates: fixed ? [{ id: 'm1', status: 'fixed' }] : [],
      concepts_covered: [{ id: 'k1', quality: 'correct' }],
      errors_taught: [],
      clarity_signals: { used_example: true, used_analogy: false, checked_understanding: false },
    },
  });
}

test('teaching: plan hidden, resumed lesson, append-only turns, "too short" before turn 4', async () => {
  const replies: FakeReply[] = [reply(PLAN), turn('Ahh, então a luz é tipo comida?'), turn('Entendi! Resumindo: a clorofila capta luz.', true)];
  const h = makeHarness(() => replies.shift() ?? turn('ok'));
  await seedWorld(h);

  const start = await teachingStart(request('teaching-start', { body: { node_id: IDS.topic, length: 'short' }, idem: v7(1) }), h.deps);
  assertEquals(start.status, 200);
  const started = await json(start);
  assertEquals(started.turn_limit, 6);
  assertEquals(started.resumed, false);
  assert(started.opening.includes('Fotossíntese'));
  assert(!JSON.stringify(started).includes('come terra'), 'the plan never leaves the server');
  const session = h.db.rows('teaching_sessions')[0]!;
  assertEquals((session.plan as { model: typeof PLAN }).model.misconceptions[0]!.id, 'm1');

  // A second start on the same topic resumes the open lesson without a new plan call.
  const again = await json(await teachingStart(request('teaching-start', { body: { node_id: IDS.topic, length: 'short' }, idem: v7(2) }), h.deps));
  assertEquals(again.session_id, started.session_id);
  assertEquals(again.resumed, true);
  assertEquals(h.claude.calls.length, 1);

  const t1 = await teachingTurn(request('teaching-turn', { body: { session_id: started.session_id, message: 'A clorofila capta a luz do sol.' }, idem: v7(3) }), h.deps);
  const frames = parseSse(await t1.text());
  assertEquals((frames.find((f) => f.event === 'delta')!.data as { text: string }).text, 'Ahh, então a luz é tipo comida?');
  const done = frames.at(-1)!.data as { result: { turn: number; final: boolean } };
  assertEquals(done.result.turn, 1);
  assertEquals(done.result.final, false);

  // Turn 2 replays turn 1 verbatim: the earlier messages are a prefix of the new request.
  const t2 = await teachingTurn(request('teaching-turn', { body: { session_id: started.session_id, message: 'E ela usa CO2 do ar.' }, idem: v7(4) }), h.deps);
  assertEquals(t2.status, 200, await t2.clone().text());
  const m1 = h.claude.calls[1]!.params.messages as unknown[];
  const m2 = h.claude.calls[2]!.params.messages as unknown[];
  assertEquals(m2.slice(0, m1.length), m1);
  assertEquals((m2[m1.length] as { role: string }).role, 'assistant');
  const state = h.db.rows('teaching_sessions')[0]!.evaluation_state as { misconceptions: Record<string, string> };
  assertEquals(state.misconceptions.m1, 'fixed');

  // Another student cannot read or continue the lesson.
  const bob = await teachingTurn(request('teaching-turn', { token: BOB.jwt, body: { session_id: started.session_id, message: 'oi' }, idem: v7(5) }), h.deps);
  assertEquals(bob.status, 404);

  // Ending after 2 turns: Lucas does the teach-back now, and the score is "too short".
  const fin = await json(await teachingFinish(request('teaching-finish', { body: { session_id: started.session_id }, idem: v7(6) }), h.deps));
  assertEquals(fin.too_short, true);
  assertEquals(fin.score, null);
  assert(fin.teach_back.length > 0);
  const row = h.db.rows('teaching_sessions')[0]!;
  assertEquals(row.status, 'finished');
  assertEquals(h.enqueued.filter((e) => e.queue === 'xp.award').length, 0);
});

const GRADE = {
  built_rubric: false,
  criteria: [
    { id: 'r1', criterion: 'Cita a clorofila', points_max: 2, points: 9, verdict: 'full', justification: 'Citou.' },
    { id: 'r2', criterion: 'Explica a glicose', points_max: 3, points: 0, verdict: 'none', justification: 'Não explicou.' },
  ],
  strengths: ['Clareza'],
  missing: [{ point: 'Produção de glicose', source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }] }],
  model_answer: 'A clorofila capta luz e a planta produz glicose.',
  misconceptions: [],
  suggested_cause: 'didnt_know',
  grader_confidence: 'high',
  feedback: 'Faltou a glicose.',
  remediation_card: null,
};

test('scoreEssay: criteria are capped at the stored rubric; an unknown criterion is unusable', () => {
  const rubric = [
    { id: 'r1', criterion: 'a', points: 2 },
    { id: 'r2', criterion: 'b', points: 3 },
  ];
  const scored = scoreEssay(GRADE as never, rubric, 5)!;
  assertEquals(scored.points, 2);
  assertEquals(scored.score, 0.4);
  assertEquals(scoreEssay({ ...GRADE, criteria: [{ ...GRADE.criteria[0]!, id: 'r9' }, GRADE.criteria[1]!] } as never, rubric, 5), null);
  // A built rubric is rescaled to the maximum (PRA-07.4): 2 of 5 built points on a 10-point question.
  const built = scoreEssay({ ...GRADE, criteria: GRADE.criteria.map((c) => ({ ...c, points: Math.min(c.points, c.points_max) })) } as never, null, 10)!;
  assertEquals(built.points, 4);
});

test('grade-essay: school answer to a bank question is scored in code and a low score opens a Caderno entry', async () => {
  const h = makeHarness(reply(GRADE));
  await seedWorld(h);
  const qid = IDS.question;
  h.db.seed('questions', {
    id: qid,
    subject_id: IDS.subject,
    node_id: IDS.topic,
    concept_ids: [IDS.concept],
    type: 'essay_question',
    stem: 'Explique a fotossíntese.',
    payload: {
      model_answer: 'A clorofila capta luz e a planta produz glicose.',
      rubric: [
        { id: 'r1', criterion: 'Cita a clorofila', points: 2 },
        { id: 'r2', criterion: 'Explica a glicose', points: 3 },
      ],
      max_points: 5,
      key_terms: [],
    },
    explanation: 'x',
    source_pages: [],
    personal_for_user_id: null,
    status: 'active',
    deleted_at: null,
    version: 1,
  });
  const essayId = v7(700);
  h.db.seed('essays', { id: essayId, user_id: (await import('./fakes.ts')).ALICE.id, kind: 'school_answer', question_id: qid, prompt: null, text: 'A clorofila capta luz.', image_paths: [], capture_id: null, transcription_original: null, edited_ratio: null, status: 'draft', feedback: null, parent_essay_id: null, deleted_at: null });
  const res = await gradeEssay(request('grade-essay', { body: { essay_id: essayId } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.mode, 'sync');
  assertEquals(body.essay.feedback.points_awarded, 2);
  assertEquals(body.essay.feedback.score, 0.4);
  assertEquals(body.essay.feedback.missing[0].source_pages[0].document_id, IDS.doc);
  assertEquals(h.db.rows('essays')[0]!.status, 'graded');
  assertEquals(h.db.rows('mistakes').length, 1);
  assertEquals(h.db.rows('attempt_answers')[0]!.essay_id, essayId);

  // Graded once: a repeat is free.
  await gradeEssay(request('grade-essay', { body: { essay_id: essayId }, idem: v7(2) }), h.deps);
  assertEquals(h.claude.calls.length, 1);
  const bob = await gradeEssay(request('grade-essay', { token: BOB.jwt, body: { essay_id: essayId }, idem: v7(3) }), h.deps);
  assertEquals(bob.status, 404);
});

test('grade-essay: an ENEM redação goes to the worker (202, essay.grade)', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const { ALICE } = await import('./fakes.ts');
  const essayId = v7(701);
  h.db.seed('essays', { id: essayId, user_id: ALICE.id, kind: 'enem_redacao', question_id: null, prompt: null, text: 'Texto da redação.', image_paths: [], capture_id: null, transcription_original: null, edited_ratio: null, status: 'draft', feedback: null, parent_essay_id: null, deleted_at: null });
  const res = await gradeEssay(request('grade-essay', { body: { essay_id: essayId } }), h.deps);
  assertEquals(res.status, 202);
  assertEquals(h.enqueued.find((e) => e.queue === 'essay.grade')?.data.essay_id, essayId);
  assertEquals(h.db.rows('essays')[0]!.status, 'grading');
  const twice = await gradeEssay(request('grade-essay', { body: { essay_id: essayId }, idem: v7(2) }), h.deps);
  assertEquals(twice.status, 409);
});

test('problem-check-work: points at the first wrong step; only problem items', async () => {
  const h = makeHarness(reply({ student_steps: ['F = m·a', 'F = 2·3 = 5'], first_wrong_step_index: 1, what_went_wrong: '2·3 é 6.', nudge: 'Refaça a multiplicação.' }));
  await seedWorld(h);
  h.db.seed('questions', {
    id: IDS.question2,
    subject_id: IDS.subject,
    node_id: IDS.topic,
    type: 'problem',
    stem: 'Calcule F para m = 2 kg e a = 3 m/s².',
    payload: { given: { m: '2', a: '3' }, final_answer: '6', answer_format: 'numeric', tolerance: 0.01, check_expression: 'm*a', solution_steps: ['F = m·a', 'F = 6 N'], hints: ['a', 'b', 'c'] },
    personal_for_user_id: null,
    deleted_at: null,
  });
  const res = await checkWork(request('problem-check-work', { body: { question_id: IDS.question2, working: 'F = m·a\nF = 2·3 = 5' } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.first_wrong_step_index, 1);
  assertEquals(body.nudge, 'Refaça a multiplicação.');
  // The working is data in the prompt, not instructions.
  assert(JSON.stringify(h.claude.calls[0]!.params.messages).includes('F = 2·3 = 5'));
});
