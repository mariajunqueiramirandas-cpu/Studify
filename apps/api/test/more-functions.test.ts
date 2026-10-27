import { test } from 'bun:test';
// Happy paths and access checks for the functions the other suites only reach through 401/400.
import { assertEquals } from './assert.ts';
import { ALICE, BOB, makeHarness, request, json, type FakeReply } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as ingestRetry } from '../src/functions/ingest-retry.ts';
import { handler as uploadPhotos } from '../src/functions/upload-photos.ts';
import { handler as cardDraft } from '../src/functions/card-draft.ts';
import { handler as questionsGenerateMore } from '../src/functions/questions-generate-more.ts';
import { handler as reportCreate } from '../src/functions/report-create.ts';
import { handler as planRecompute } from '../src/functions/plan-recompute.ts';
import { handler as vesperaPrepare } from '../src/functions/vespera-prepare.ts';
import { handler as gradeAnswer } from '../src/functions/grade-answer.ts';

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

test('ingest-retry: a failed document is queued again; a ready one has nothing to retry', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.seed('documents', { id: v7(800), subject_id: IDS.subject, title: 'Falhou', kind: 'notes', storage_path: `documents/${IDS.subject}/x.pdf`, size_bytes: 10, checksum_sha256: 'e'.repeat(64), status: 'failed', deleted_at: null });
  const ok = await ingestRetry(request('ingest-retry', { idem: v7(801), body: { document_id: v7(800), from_stage: 'S1' } }), h.deps);
  assertEquals(ok.status, 202);
  assertEquals(h.enqueued.find((e) => e.queue === 'ingest.document')?.data.from_stage, 'S1');
  const ready = await ingestRetry(request('ingest-retry', { idem: v7(802), body: { document_id: IDS.doc } }), h.deps);
  assertEquals(ready.status, 409);
});

test('upload-photos: queues the PDF build for the student’s own photos; another student’s path is forbidden', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const own = `photos/${ALICE.id}/cap1/1.jpg`;
  h.db.objects.set(`photos/${ALICE.id}/cap1/1.jpg`, new Uint8Array([1, 2, 3]));
  const ok = await uploadPhotos(request('upload-photos', { idem: v7(810), body: { subject_id: IDS.subject, image_paths: [own] } }), h.deps);
  assertEquals(ok.status, 202);
  assertEquals(h.enqueued.find((e) => e.queue === 'ingest.photos_to_pdf') !== undefined, true);
  const foreign = `photos/${BOB.id}/cap9/1.jpg`;
  h.db.objects.set(foreign, new Uint8Array([1]));
  const bad = await uploadPhotos(request('upload-photos', { idem: v7(811), body: { subject_id: IDS.subject, image_paths: [foreign] } }), h.deps);
  assertEquals(bad.status, 403);
});

test('card-draft: drafts one card from a selection; a document of another subject is not found', async () => {
  const h = makeHarness(reply({ type: 'basic', front: 'O que é clorofila?', back: 'Pigmento que capta luz.', cloze_text: null, concept_key: IDS.concept }));
  await seedWorld(h);
  const ok = await cardDraft(request('card-draft', { idem: v7(820), body: { subject_id: IDS.subject, selection: 'clorofila capta luz', source: 'pdf', document_id: IDS.doc, page: 13 } }), h.deps);
  assertEquals(ok.status, 200);
  const body = await json(ok);
  assertEquals(body.type, 'basic');
  assertEquals(body.source_pages, [{ document_id: IDS.doc, page_start: 13, page_end: 13 }]);
  const foreign = await cardDraft(request('card-draft', { idem: v7(821), body: { subject_id: IDS.bobSubject, selection: 'x', source: 'note' } }), h.deps);
  assertEquals(foreign.status, 404);
});

test('questions-generate-more: a topic in another student’s subject is not found; nothing is called', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const foreign = await questionsGenerateMore(request('questions-generate-more', { idem: v7(830), body: { node_id: IDS.bobTopic } }), h.deps);
  assertEquals(foreign.status, 404);
  assertEquals(h.claude.calls.length, 0);
});

test('report-create: a Turma report needs membership; a report on a person is stored and dispatched', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const group = v7(840);
  h.db.seed('class_groups', { id: group, name: 'Turma 2A', allow_member_uploads: false });
  const notMember = await reportCreate(request('report-create', { idem: v7(841), body: { class_group_id: group, reason: 'spam' } }), h.deps);
  assertEquals(notMember.status, 403);
  assertEquals((await json(notMember)).error.code, 'not_member');
  const person = await reportCreate(request('report-create', { idem: v7(842), body: { reported_id: BOB.id, reason: 'harassment' } }), h.deps);
  assertEquals(person.status, 200);
  assertEquals(h.db.rows('user_reports').length, 1);
  // No Turma: the app admins (the operator) are told, one notify.dispatch each, never a null user.
  assertEquals(h.enqueued.filter((e) => e.queue === 'notify.dispatch').length, 0, 'no admin yet');
});

test('report-create: a Turma report notifies its owner and moderators, not the reporter; one dispatch each', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const group = v7(843);
  const owner = v7(844);
  const moderator = v7(845);
  h.db.seed('class_groups', { id: group, name: 'Turma 2B', allow_member_uploads: false });
  h.db.seed('class_group_members', [
    { class_group_id: group, user_id: ALICE.id, role: 'moderator', status: 'active' },
    { class_group_id: group, user_id: owner, role: 'owner', status: 'active' },
    { class_group_id: group, user_id: moderator, role: 'moderator', status: 'active' },
    { class_group_id: group, user_id: BOB.id, role: 'moderator', status: 'removed' },
  ]);
  const res = await reportCreate(request('report-create', { idem: v7(846), body: { class_group_id: group, reason: 'spam' } }), h.deps);
  assertEquals(res.status, 200);
  const dispatched = h.enqueued.filter((e) => e.queue === 'notify.dispatch').map((e) => e.data.user_id);
  assertEquals(dispatched.sort(), [owner, moderator].sort(), 'the reporter (a moderator herself) and removed members are not told');
});

test('report-create: a report with no Turma goes to the app admins', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const admin = v7(848);
  h.db.seed('profiles', { id: admin, display_name: 'Operador', app_role: 'app_admin' });
  const res = await reportCreate(request('report-create', { idem: v7(849), body: { reported_id: BOB.id, reason: 'harassment' } }), h.deps);
  assertEquals(res.status, 200);
  const dispatched = h.enqueued.filter((e) => e.queue === 'notify.dispatch');
  assertEquals(dispatched.map((e) => e.data.user_id), [admin]);
});

test('plan-recompute: a student’s goal is queued once; a second call inside the window coalesces', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const first = await planRecompute(request('plan-recompute', { idem: v7(850), body: { trigger: 'user_rebalance', goal_id: IDS.goal } }), h.deps);
  assertEquals(first.status, 202);
  assertEquals((await json(first)).status, 'queued');
  const second = await planRecompute(request('plan-recompute', { idem: v7(851), body: { trigger: 'user_rebalance', goal_id: IDS.goal } }), h.deps);
  assertEquals((await json(second)).status, 'coalesced');
  const foreign = await planRecompute(request('plan-recompute', { idem: v7(852), body: { trigger: 'nightly', goal_id: IDS.bobExam } }), h.deps);
  assertEquals(foreign.status, 404);
});

test('vespera-prepare: queues the sheet for the student’s exam; another student’s exam is not found', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const ok = await vesperaPrepare(request('vespera-prepare', { idem: v7(860), body: { exam_id: IDS.exam } }), h.deps);
  assertEquals(ok.status, 202);
  assertEquals((await json(ok)).status, 'preparing');
  assertEquals(h.enqueued.some((e) => e.queue === 'vespera.prepare'), true);
  const foreign = await vesperaPrepare(request('vespera-prepare', { idem: v7(861), body: { exam_id: IDS.bobExam } }), h.deps);
  assertEquals(foreign.status, 404);
});

test('grade-answer: a short answer is graded against the rubric; 0.5 does not open a Caderno entry', async () => {
  const h = makeHarness(reply({
    score: 0.5,
    criteria: [
      { id: 'r1', verdict: 'full', points: 1, justification: 'Citou a luz.' },
      { id: 'r2', verdict: 'none', points: 0, justification: 'Não falou da energia química.' },
    ],
    feedback: 'Boa base. Falta a energia química.',
    missing: [],
    suggested_cause: 'didnt_know',
    remediation_card: null,
    grader_confidence: 'high',
  }));
  await seedWorld(h);
  h.db.seed('questions', [{ id: IDS.question, subject_id: IDS.subject, node_id: IDS.topic, concept_ids: [IDS.concept], type: 'short_answer', stem: 'Explique a fotossíntese.', payload: { model_answer: 'Luz vira energia química.', rubric: [{ id: 'r1', criterion: 'Luz', points: 1 }, { id: 'r2', criterion: 'Energia química', points: 1 }], max_points: 2, key_terms: [] }, explanation: 'A luz é convertida.', source_pages: [], personal_for_user_id: null, deleted_at: null }]);
  h.db.seed('quiz_attempts', { id: IDS.attempt, user_id: ALICE.id, quiz_id: IDS.quiz, status: 'in_progress' });
  h.db.seed('attempt_answers', { id: v7(870), attempt_id: IDS.attempt, user_id: ALICE.id, question_id: IDS.question, response: { text: 'A planta usa luz.' }, time_spent_ms: 20000, confidence: 3, grading_status: 'pending' });
  const res = await gradeAnswer(request('grade-answer', { idem: v7(871), body: { attempt_answer_id: v7(870) } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.score, 0.5);
  assertEquals(body.points_awarded, 1);
  assertEquals(body.feedback.criteria.length, 2);
  assertEquals(h.db.rows('attempt_answers')[0]?.grading_status, 'graded');
  // Caderno entries start below 0.5 (PRA-04.1): 0.5 does not open one.
  assertEquals(h.db.rows('mistakes').length, 0);
});
