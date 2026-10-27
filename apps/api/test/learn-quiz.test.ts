import { test } from 'bun:test';
// Quiz scoring and assembly, card generation with page checks, the explanation cache, notes, scope matching,
// flags (IDOR), account deletion (re-auth) and the signup age gate.
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, makeHarness, parseSse, request, json, type FakeReply } from './fakes.ts';
import { IDS, mcq, seedWorld, v7 } from './world.ts';
import { handler as quizSubmit } from '../src/functions/quiz-submit.ts';
import { handler as quizCreate } from '../src/functions/quiz-create.ts';
import { handler as gradeAnswer } from '../src/functions/grade-answer.ts';
import { handler as cardsMore } from '../src/functions/cards-generate-more.ts';
import { handler as explain } from '../src/functions/explain.ts';
import { handler as noteGenerate } from '../src/functions/note-generate.ts';
import { handler as scopeResolve } from '../src/functions/scope-resolve.ts';
import { handler as flagCreate } from '../src/functions/flag-create.ts';
import { handler as accountDelete } from '../src/functions/account-delete.ts';
import { BOOTSTRAP_INVITE_CODE, handler as signupComplete } from '../src/functions/signup-complete.ts';

const json_reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

test('quiz-submit: the server scores every answer, creates a Caderno entry, a remediation card and evidence', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('questions', [mcq(IDS.question, 'A'), mcq(IDS.question2, 'A')]);
  h.db.seed('quizzes', { id: IDS.quiz, owner_id: ALICE.id, question_ids: [IDS.question, IDS.question2], kind: 'practice', goal_id: null });
  h.db.seed('quiz_attempts', { id: IDS.attempt, user_id: ALICE.id, quiz_id: IDS.quiz, status: 'in_progress', device_id: 'device-1', started_at: '2026-10-27T14:00:00Z' });
  const res = await quizSubmit(
    request('quiz-submit', {
      idem: v7(500),
      body: {
        attempt_id: IDS.attempt,
        finished_at: '2026-10-27T14:20:00Z',
        answers: [
          { id: v7(501), question_id: IDS.question, response: { choice: 'A' }, confidence: 4, time_spent_ms: 9000 },
          { id: v7(502), question_id: IDS.question2, response: { choice: 'B' }, confidence: 4, time_spent_ms: 15000 },
        ],
      },
    }),
    h.deps,
  );
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.attempt.status, 'submitted');
  assertEquals(body.attempt.score, 0.5);
  assertEquals(body.mistakes_created.length, 1);
  assertEquals(body.cards_created.length, 1);
  assertEquals(body.pending_ai_grading, 0);
  const answers = h.db.rows('attempt_answers');
  assertEquals(answers.find((a) => a.question_id === IDS.question2)?.correct, false);
  assertEquals(answers.find((a) => a.question_id === IDS.question)?.score, 1);
  assertEquals(h.db.rows('mastery_evidence').length, 2, 'one evidence row per graded answer');
  assertEquals(h.db.rows('cards').find((c) => c.origin === 'from_mistake')?.personal_for_user_id, ALICE.id);
  assertEquals(h.claude.calls.length, 0, 'auto-graded answers never call Claude');
});

test('quiz-submit: another student’s attempt is not found, and a submitted attempt cannot be sent twice', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('quiz_attempts', { id: IDS.bobAttempt, user_id: BOB.id, quiz_id: IDS.quiz, status: 'in_progress', device_id: 'x', started_at: '2026-10-27T14:00:00Z' });
  const foreign = await quizSubmit(request('quiz-submit', { idem: v7(510), body: { attempt_id: IDS.bobAttempt, answers: [], finished_at: '2026-10-27T14:20:00Z' } }), h.deps);
  assertEquals(foreign.status, 404);
  h.db.seed('quiz_attempts', { id: IDS.attempt, user_id: ALICE.id, quiz_id: IDS.quiz, status: 'submitted', device_id: 'x', started_at: '2026-10-27T14:00:00Z' });
  const again = await quizSubmit(request('quiz-submit', { idem: v7(511), body: { attempt_id: IDS.attempt, answers: [], finished_at: '2026-10-27T14:20:00Z' } }), h.deps);
  assertEquals(again.status, 409);
});

test('quiz-create: a practice quiz is drawn from the bank with an open attempt, without Claude', async () => {
  const h = makeHarness();
  await seedWorld(h);
  // Three concepts: the selector takes at most two questions per concept (learning-engine §6.3).
  const questions = Array.from({ length: 6 }, (_, i) => mcq(v7(600 + i), 'A', IDS.topic, v7(700 + (i % 3))));
  h.db.seed('questions', questions);
  const res = await quizCreate(request('quiz-create', { idem: v7(610), body: { kind: 'practice', scope: { subject_id: IDS.subject }, count: 5, mode: 'practice' } }), h.deps);
  assertEquals(res.status, 201);
  const body = await json(res);
  assertEquals(body.question_ids.length, 5);
  assertEquals(body.generated, 0);
  assert(body.quiz_id && body.attempt_id);
  assertEquals(h.db.rows('quiz_attempts').find((a) => a.id === body.attempt_id)?.status, 'in_progress');
  assertEquals(h.claude.calls.length, 0);
});

test('quiz-create: a predicted test without an exam is invalid, and a foreign subject is not found', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const predicted = await quizCreate(request('quiz-create', { idem: v7(611), body: { kind: 'predicted_test', scope: { subject_id: IDS.subject }, count: 5, mode: 'exam_conditions' } }), h.deps);
  assertEquals(predicted.status, 400, 'a predicted test needs an exam');
  const foreign = await quizCreate(request('quiz-create', { idem: v7(612), body: { kind: 'practice', scope: { subject_id: IDS.bobSubject }, count: 5, mode: 'practice' } }), h.deps);
  assertEquals(foreign.status, 404);
});

test('grade-answer: an empty answer scores 0 without calling Claude', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('questions', [{ id: IDS.question, subject_id: IDS.subject, node_id: IDS.topic, concept_ids: [], type: 'short_answer', stem: 'Explique a fotossíntese.', payload: { model_answer: 'Luz vira energia química.', rubric: [{ id: 'r1', criterion: 'Luz', points: 1 }, { id: 'r2', criterion: 'Energia', points: 1 }], max_points: 2, key_terms: [] }, explanation: 'Explicação.', source_pages: [], personal_for_user_id: null, deleted_at: null }]);
  h.db.seed('quiz_attempts', { id: IDS.attempt, user_id: ALICE.id, quiz_id: IDS.quiz, status: 'in_progress' });
  h.db.seed('attempt_answers', { id: v7(620), attempt_id: IDS.attempt, user_id: ALICE.id, question_id: IDS.question, response: null, time_spent_ms: 0, confidence: null, grading_status: 'pending' });
  const res = await gradeAnswer(request('grade-answer', { idem: v7(621), body: { attempt_answer_id: v7(620) } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.score, 0);
  assertEquals(body.points_max, 2);
  assertEquals(h.claude.calls.length, 0);
});

test('cards-generate-more: stores new cards with original source pages and drops duplicate fronts', async () => {
  const h = makeHarness(json_reply({
    cards: [
      { type: 'basic', front: 'O que a clorofila faz?', back: 'Capta luz.', cloze_text: null, concept_key: IDS.concept, source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }], difficulty_estimate: 2 },
      { type: 'basic', front: 'O que é a clorofila?', back: 'Pigmento.', cloze_text: null, concept_key: IDS.concept, source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }], difficulty_estimate: 1 },
    ],
  }));
  await seedWorld(h);
  const res = await cardsMore(request('cards-generate-more', { idem: v7(630), body: { node_id: IDS.topic } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  // "O que é a clorofila?" is already a card of this topic (world fixture): the duplicate front is dropped.
  assertEquals(body.card_ids.length, 1);
  const created = h.db.rows('cards').filter((c) => c.origin === 'generated' && c.id !== IDS.card);
  assertEquals(created.length, 1);
  assertEquals(created[0]?.front, 'O que a clorofila faz?');
  assertEquals((created[0]?.source_pages as Array<{ document_id: string; page_start: number }>)[0]?.document_id, IDS.doc);
  assertEquals((created[0]?.source_pages as Array<{ page_start: number }>)[0]?.page_start, 13);
});

test('explain: a shared explanation is streamed from the cache with no Claude call', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('explanations', { id: v7(640), subject_id: IDS.subject, target_type: 'concept', target_id: IDS.concept, paragraph_index: null, style: 'simpler', language: 'pt-BR', body: 'Clorofila é a cor verde das folhas.', citations: [], personal_for_user_id: null, prompt_version: 'explain.restyle@v1' });
  const res = await explain(request('explain', { idem: v7(641), body: { target_type: 'concept', target_id: IDS.concept, style: 'simpler' } }), h.deps);
  const frames = parseSse(await res.text());
  assertEquals(frames.map((f) => f.event), ['meta', 'delta', 'done']);
  assertEquals((frames[1]!.data as { text: string }).text, 'Clorofila é a cor verde das folhas.');
  assertEquals(h.claude.calls.length, 0);
});

test('note-generate: a tldr is queued for the worker (202), a deep note streams and is stored', async () => {
  const h = makeHarness({ content: [{ type: 'text', text: 'Fotossíntese transforma luz em energia.' }] });
  await seedWorld(h);
  const tldr = await noteGenerate(request('note-generate', { idem: v7(650), body: { node_id: IDS.topic, depth: 'tldr' } }), h.deps);
  assertEquals(tldr.status, 202);
  assertEquals(h.enqueued.find((e) => e.queue === 'content.regenerate_topic')?.data.node_id, IDS.topic);

  const deep = await noteGenerate(request('note-generate', { idem: v7(651), body: { node_id: IDS.topic, depth: 'deep' } }), h.deps);
  const frames = parseSse(await deep.text());
  assertEquals(frames.at(-1)?.event, 'done');
  const noteId = (frames.at(-1)!.data as { result: { note_id: string } }).result.note_id;
  const note = h.db.rows('notes').find((n) => n.id === noteId)!;
  assertEquals(note.status, 'ready');
  assertEquals(note.body, 'Fotossíntese transforma luz em energia.');
});

test('scope-resolve: matches the content list to the map and stores a draft for review', async () => {
  const h = makeHarness(json_reply({
    items: [{ raw_text: 'Fotossíntese', normalized_title: 'Fotossíntese', matches: [{ node_key: IDS.topic, confidence: 0.92 }], status: 'matched', note: null }],
    detected_exam_info: { subject_guess: null, date_guess: null },
  }));
  await seedWorld(h);
  h.db.seed('exam_scope_items', []);
  const res = await scopeResolve(request('scope-resolve', { idem: v7(660), body: { exam_id: IDS.exam, items: ['Fotossíntese'] } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.scope_status, 'pending_review');
  assertEquals(body.items[0].nodes[0].node_id, IDS.topic);
  assertEquals(h.db.rows('exams').find((e) => e.id === IDS.exam)?.scope_status, 'pending_review');
  assertEquals(h.db.rows('exam_scope_nodes').length, 1);
});

test('flag-create: flags a visible card once; another student’s personal card is not found', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const ok = await flagCreate(request('flag-create', { idem: v7(670), body: { item_type: 'card', item_id: IDS.card, reason: 'wrong_fact' } }), h.deps);
  assertEquals(ok.status, 200);
  assertEquals(h.enqueued.find((e) => e.queue === 'flag.triage') !== undefined, true);
  const again = await flagCreate(request('flag-create', { idem: v7(671), body: { item_type: 'card', item_id: IDS.card, reason: 'unclear' } }), h.deps);
  assertEquals((await json(again)).flag_id, (await json(ok)).flag_id, 'one open flag per reporter and item');
  const foreign = await flagCreate(request('flag-create', { idem: v7(672), body: { item_type: 'card', item_id: IDS.bobCard, reason: 'wrong_fact' } }), h.deps);
  assertEquals(foreign.status, 404);
});

test('account-delete: a wrong email code is refused; the right one queues the deletion and signs out', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.otpCode = '123456';
  const wrong = await accountDelete(request('account-delete', { idem: v7(680), body: { otp_code: '000000', delete_shared_uploads: false } }), h.deps);
  assertEquals(wrong.status, 403);
  const right = await accountDelete(request('account-delete', { idem: v7(681), body: { otp_code: '123456', delete_shared_uploads: true } }), h.deps);
  assertEquals(right.status, 202);
  assert(h.db.signedOut.some((s) => s.endsWith(':global')));
  assertEquals(h.enqueued.find((e) => e.queue === 'account.delete') !== undefined, true);
  assertEquals(h.db.rows('account_deletions')[0]?.delete_shared_uploads, true);
});

test('signup-complete: under 12 is refused, the auth user is removed, nothing is stored', async () => {
  const h = makeHarness();
  withUser(h, 'carla');
  const res = await signupComplete(request('signup-complete', { token: 'jwt-carla', body: { invite_code: 'ABCDEFGH', birth_month: 1, birth_year: 2020, display_name: 'Carla', school_year: 'ef9', privacy_notice_version: 'v1' } }), h.deps);
  assertEquals(res.status, 422);
  assertEquals((await json(res)).error.code, 'under_age');
  assertEquals(h.db.deletedUsers, ['carla-id']);
  assertEquals(h.db.rows('profiles').length, 0);
});

test('signup-complete: a valid pilot invite creates the profile and uses one invite', async () => {
  const h = makeHarness();
  withUser(h, 'carla');
  h.db.seed('invites', { id: v7(690), code: 'ABCDEFGH', class_group_id: null, uses_left: 3, expires_at: '2027-01-01T00:00:00Z', revoked_at: null, email: null });
  const res = await signupComplete(request('signup-complete', { token: 'jwt-carla', body: { invite_code: 'ABCDEFGH', birth_month: 5, birth_year: 2010, display_name: 'Carla', school_year: 'em1', privacy_notice_version: 'v1' } }), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await json(res)).profile_id, 'carla-id');
  assertEquals(h.db.rows('invites')[0]?.uses_left, 2);
  const again = await signupComplete(request('signup-complete', { token: 'jwt-carla', body: { invite_code: 'ABCDEFGH', birth_month: 5, birth_year: 2010, display_name: 'Carla', school_year: 'em1', privacy_notice_version: 'v1' } }), h.deps);
  assertEquals((await json(again)).error.code, 'already_completed');
});

test('signup-complete: the bootstrap code makes the first account the owner, then stops working', async () => {
  const h = makeHarness();
  withUser(h, 'carla');
  withUser(h, 'davi');
  const body = { invite_code: BOOTSTRAP_INVITE_CODE, birth_month: 5, birth_year: 1990, display_name: 'Carla', school_year: 'em1', privacy_notice_version: 'v1' };
  const res = await signupComplete(request('signup-complete', { token: 'jwt-carla', body }), h.deps);
  assertEquals(res.status, 200);
  const owner = h.db.rows('profiles').find((p) => p.id === 'carla-id');
  assertEquals(owner?.app_role, 'app_admin');
  assertEquals(owner?.invite_id, null);
  const second = await signupComplete(request('signup-complete', { token: 'jwt-davi', body: { ...body, display_name: 'Davi' } }), h.deps);
  assertEquals((await json(second)).error.code, 'invite_invalid');
  assertEquals(h.db.rows('profiles').length, 1);
});

function withUser(h: ReturnType<typeof makeHarness>, name: string) {
  h.db.users.set(`jwt-${name}`, { id: `${name}-id`, email: `${name}@example.com` });
}

