import { test } from 'bun:test';
// Phase 5: auto visuals (cached per topic and type, "não fica bom em diagrama" cached too), mnemonic options
// checked before they reach the student, Dividir e conquistar (private review, moderated submit, automatic merge),
// Perguntas da turma (validation, pending pool, daily limit) and Chefões (selection and the recorded attempt).
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, request, type FakeReply, type Harness } from './fakes.ts';
import { IDS, mcq, seedWorld, v7 } from './world.ts';
import { handler as visualGenerate } from '../src/functions/visual-generate.ts';
import { handler as mnemonicSuggest, listItemsOf } from '../src/functions/mnemonic-suggest.ts';
import { handler as divideReview } from '../src/functions/divide-review.ts';
import { handler as divideSubmit } from '../src/functions/divide-submit.ts';
import { handler as divideMerge } from '../src/functions/divide-merge.ts';
import { handler as peerCreate, duplicateQuery } from '../src/functions/peer-question-create.ts';
import { handler as quizCreate } from '../src/functions/quiz-create.ts';
import { handler as quizSubmit } from '../src/functions/quiz-submit.ts';

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const queue = (...values: unknown[]) => {
  const replies = values.map(reply);
  return () => replies.shift() ?? reply('{}');
};

/** The flat shape the model writes for visual.generate (decodeVisual rebuilds the typed visual). */
const asDraft = (out: { fits: boolean; reason: string | null; visual: Record<string, unknown> | null }) => ({
  fits: out.fits,
  reason: out.reason,
  type: out.visual?.type ?? 'none',
  title: out.visual?.title ?? '',
  alt_text: out.visual?.alt_text ?? '',
  nodes: ((out.visual?.nodes as Record<string, unknown>[] | undefined) ?? []).map((n) => ({ parent_id: null, ...n })),
  edges: out.visual?.edges ?? [],
  events: out.visual?.events ?? [],
  columns: out.visual?.columns ?? [],
  rows: out.visual?.rows ?? [],
});

const ref = { doc: 'D1', page_start: 12, page_end: 12 };
const FLOW = {
  fits: true,
  reason: null,
  visual: {
    type: 'flowchart',
    title: 'Fotossíntese',
    alt_text: 'A luz é captada pela clorofila e a energia vira glicose no cloroplasto.',
    nodes: [
      { id: 'n1', label: 'Luz', detail: null, source: ref },
      { id: 'n2', label: 'Clorofila', detail: null, source: { doc: 'D1', page_start: 13, page_end: 13 } },
      { id: 'n3', label: 'Glicose', detail: null, source: null },
    ],
    edges: [
      { from: 'n1', to: 'n2', label: null },
      { from: 'n2', to: 'n3', label: null },
    ],
  },
};

test('visual-generate: stores the spec with document pages, reuses it, feeds a diagram card; caches "não fica bom"', async () => {
  const h = makeHarness(queue(asDraft(FLOW), asDraft({ fits: false, reason: 'Esse tópico não fica bom em linha do tempo.', visual: null })));
  await seedWorld(h);
  const res = await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic, type: 'flowchart' }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 201, await res.clone().text());
  const body = await json(res);
  assertEquals(body.fits, true);
  assertEquals(body.visual.spec.nodes[0].source_pages, [{ document_id: IDS.doc, page_start: 12, page_end: 12 }]);
  assertEquals(body.visual.source_pages.length, 2);
  assertEquals(h.db.rows('feed_items').filter((f) => f.type === 'diagram').length, 1);

  const again = await json(await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic }, idem: v7(2) }), h.deps));
  assertEquals(again.cached, true);
  assertEquals(h.claude.calls.length, 1);

  // A specific type that does not fit is answered but not cached; an outsider never reaches the topic.
  const timeline = await json(await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic, type: 'timeline' }, idem: v7(3) }), h.deps));
  assertEquals(timeline.fits, false);
  assertEquals(h.db.rows('visuals').length, 1);
  const bob = await visualGenerate(request('visual-generate', { token: BOB.jwt, body: { node_id: IDS.topic }, idem: v7(4) }), h.deps);
  assertEquals(bob.status, 404);
});

test('visual-generate: an automatic "no fit" is cached as type none; a broken spec is refused', async () => {
  const h = makeHarness(queue(asDraft({ fits: false, reason: 'Esse tópico não fica bom em diagrama.', visual: null })));
  await seedWorld(h);
  const first = await json(await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic }, idem: v7(1) }), h.deps));
  assertEquals(first, { fits: false, reason: 'Esse tópico não fica bom em diagrama.' });
  const second = await json(await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic }, idem: v7(2) }), h.deps));
  assertEquals(second.fits, false);
  assertEquals(h.claude.calls.length, 1);
  assertEquals(h.db.rows('visuals')[0]!.type, 'none');

  const broken = makeHarness(queue(asDraft({ ...FLOW, visual: { ...FLOW.visual, edges: [{ from: 'n1', to: 'n9', label: null }] } })));
  await seedWorld(broken);
  const res = await visualGenerate(request('visual-generate', { body: { node_id: IDS.topic, type: 'flowchart' }, idem: v7(3) }), broken.deps);
  assertEquals(res.status, 503);
  assertEquals(broken.db.rows('visuals').length, 0);
});

test('mnemonic-suggest: drops acrostics that do not encode the list; palaces must hold the list; private cards stay private', async () => {
  const items = ['Prófase', 'Metáfase', 'Anáfase', 'Telófase'];
  const h = makeHarness(
    queue({
      options: [
        { type: 'acronym', title: 'PMAT', text: 'PMAT', how_to_use: 'Lembre da sigla.', loci: null },
        { type: 'phrase', title: 'Frase', text: 'Maria Pediu Tapioca Assada', how_to_use: 'Repita a frase.', loci: null },
        { type: 'rhyme', title: 'Rima', text: 'Pró, Meta, Aná e Telo: a mitose é um belo novelo.', how_to_use: 'Cante.', loci: null },
      ],
    }),
  );
  await seedWorld(h);
  const res = await mnemonicSuggest(request('mnemonic-suggest', { body: { card_id: IDS.card, items } }), h.deps);
  assertEquals(res.status, 200, await res.clone().text());
  const body = await json(res);
  assertEquals(body.options.map((o: { type: string }) => o.type), ['acronym', 'rhyme']);
  assertEquals(body.options[0].content.items, items);

  h.db.seed('memory_palaces', { id: v7(50), user_id: ALICE.id, name: 'Casa', loci: ['portão', 'sala'], deleted_at: null });
  const small = await mnemonicSuggest(request('mnemonic-suggest', { body: { card_id: IDS.card, items, type: 'palace', palace_id: v7(50) } }), h.deps);
  assertEquals(small.status, 400);
  const otherPalace = await mnemonicSuggest(request('mnemonic-suggest', { token: BOB.jwt, body: { node_id: IDS.bobTopic, type: 'palace', palace_id: v7(50), items: ['a', 'b'] } }), h.deps);
  assertEquals(otherPalace.status, 404);
  const bob = await mnemonicSuggest(request('mnemonic-suggest', { body: { card_id: IDS.bobCard } }), h.deps);
  assertEquals(bob.status, 404);
  assertEquals(listItemsOf('Prófase, metáfase, anáfase e telófase'), ['Prófase', 'metáfase', 'anáfase', 'telófase']);
  assertEquals(listItemsOf('Pigmento que capta luz.'), []);
});

const GROUP = '77777777-7777-4777-8777-777777777777';
const SHARED = '5a000000-0000-4000-8000-0000000000c1';
const SHARED_TOPIC = 'a0000000-0000-4000-8000-0000000000c1';
const PLAN = 'd2000000-0000-4000-8000-000000000001';

function seedTurma(h: Harness): void {
  h.db.seed('class_groups', { id: GROUP, name: 'Turma A', owner_id: BOB.id });
  h.db.seed('class_group_members', [
    { class_group_id: GROUP, user_id: BOB.id, role: 'owner', status: 'active', nickname: 'Bob' },
    { class_group_id: GROUP, user_id: ALICE.id, role: 'member', status: 'active', nickname: 'Ali' },
  ]);
  h.db.seed('subjects', { id: SHARED, owner_profile_id: null, owner_class_group_id: GROUP, created_by: BOB.id, name: 'Biologia da turma', color: '#00AA00', icon: 'leaf', content_language: 'pt-BR', is_language_subject: false, enem_area: null, deleted_at: null });
  h.db.seed('knowledge_nodes', { id: SHARED_TOPIC, subject_id: SHARED, parent_id: null, kind: 'topic', title: 'Fotossíntese', summary: 'Energia da luz', learning_objectives: [], key_terms: [], formulas: [], deleted_at: null, position: 0 });
  h.db.seed('node_sources', { id: v7(901), node_id: SHARED_TOPIC, document_id: IDS.doc, page_start: 12, page_end: 14, origin: 'ai', deleted_at: null });
}

test('divisão: private review, moderated submit, and the merge starts when every claim is approved', async () => {
  const h = makeHarness(
    queue(
      { errors: [{ quote: 'acontece na mitocôndria', correction: 'Acontece no cloroplasto.', source: ref }], missing_concepts: ['Clorofila'], ok_to_merge: false, summary: 'Bom começo!' },
      { allowed: true, category: 'ok' },
    ),
  );
  await seedWorld(h);
  seedTurma(h);
  h.db.seed('divide_plans', { id: PLAN, class_group_id: GROUP, subject_id: SHARED, title: 'P1', node_ids: [SHARED_TOPIC], assignments: { [SHARED_TOPIC]: ALICE.id }, max_claims: 3, status: 'open', created_by: BOB.id });
  h.db.seed('contributions', { id: v7(60), divide_plan_id: PLAN, node_id: SHARED_TOPIC, author_id: ALICE.id, body_md: 'A fotossíntese acontece na mitocôndria e usa a luz do sol para produzir glicose e oxigênio.', status: 'draft' });

  const review = await divideReview(request('divide-review', { body: { contribution_id: v7(60) }, idem: v7(1) }), h.deps);
  assertEquals(review.status, 200, await review.clone().text());
  const fb = (await json(review)).feedback;
  assertEquals(fb.errors[0], { quote: 'acontece na mitocôndria', correction: 'Acontece no cloroplasto.', page: 12, document_id: IDS.doc });
  assertEquals((h.db.rows('contributions')[0]!.ai_feedback as { summary: string }).summary, 'Bom começo!');

  const bob = await divideReview(request('divide-review', { token: BOB.jwt, body: { contribution_id: v7(60) }, idem: v7(2) }), h.deps);
  assertEquals(bob.status, 404);

  const submit = await json(await divideSubmit(request('divide-submit', { body: { contribution_id: v7(60) }, idem: v7(3) }), h.deps));
  assertEquals(submit, { status: 'approved', merge_started: true });
  assertEquals(h.db.rows('divide_plans')[0]!.status, 'merging');
  assertEquals(h.enqueued.filter((j) => j.queue === 'divide.merge').length, 1);
});

test('divisão: only the creator or a moderator closes it early; moderation can refuse a summary', async () => {
  const h = makeHarness(queue({ allowed: false, category: 'offensive' }));
  await seedWorld(h);
  seedTurma(h);
  h.db.seed('divide_plans', { id: PLAN, class_group_id: GROUP, subject_id: SHARED, title: 'P1', node_ids: [SHARED_TOPIC], assignments: { [SHARED_TOPIC]: ALICE.id }, max_claims: 3, status: 'open', created_by: BOB.id });
  h.db.seed('contributions', { id: v7(60), divide_plan_id: PLAN, node_id: SHARED_TOPIC, author_id: ALICE.id, body_md: 'x'.repeat(120), status: 'draft' });
  const refused = await divideSubmit(request('divide-submit', { body: { contribution_id: v7(60) }, idem: v7(1) }), h.deps);
  assertEquals(refused.status, 400);
  assertEquals(h.db.rows('contributions')[0]!.status, 'draft');

  const early = await divideMerge(request('divide-merge', { body: { divide_plan_id: PLAN }, idem: v7(2) }), h.deps);
  assertEquals(early.status, 403); // alice is a member, not the creator
  const empty = await divideMerge(request('divide-merge', { token: BOB.jwt, body: { divide_plan_id: PLAN }, idem: v7(3) }), h.deps);
  assertEquals(empty.status, 400); // nothing approved yet
});

test('peer-question-create: dry run shows suggestions; a grounded question enters the pending pool; 20 per day', async () => {
  const ok = { grounded: true, evidence: [ref], single_correct_answer: true, clarity_issues: [], appropriate: true, duplicate_of: null, suggested_fix: null };
  const h = makeHarness(
    queue(
      { allowed: true, category: 'ok' },
      { ...ok, grounded: false, suggested_fix: { stem: 'A fotossíntese ocorre no cloroplasto?', payload_json: '{"statement":"A fotossíntese ocorre no cloroplasto.","correct":true,"justification":"Página 12."}', explanation: null } },
      { allowed: true, category: 'ok' },
      ok,
    ),
  );
  await seedWorld(h);
  seedTurma(h);
  const question = { subject_id: SHARED, node_id: SHARED_TOPIC, type: 'true_false', stem: 'A fotossíntese ocorre na mitocôndria?', payload: { statement: 'A fotossíntese ocorre na mitocôndria.', correct: false, justification: 'Ocorre no cloroplasto.' } };
  const dryRes = await peerCreate(request('peer-question-create', { body: { ...question, dry_run: true }, idem: v7(1) }), h.deps);
  assertEquals(dryRes.status, 200, await dryRes.clone().text());
  const dry = await json(dryRes);
  assertEquals(dry.status, 'needs_changes');
  assertEquals(dry.blocking, ['not_grounded']);
  assertEquals(dry.validation.suggested_fix.payload.correct, true);
  assertEquals(h.db.rows('questions').filter((q) => q.origin === 'peer').length, 0);

  const sent = await peerCreate(request('peer-question-create', { body: { ...question, anonymous: true }, idem: v7(2) }), h.deps);
  assertEquals(sent.status, 201, await sent.clone().text());
  const row = h.db.rows('questions').find((q) => q.origin === 'peer')!;
  assertEquals([row.review_status, row.author_id, row.author_anonymous], ['pending', ALICE.id, true]);
  assertEquals(row.source_pages, [{ document_id: IDS.doc, page_start: 12, page_end: 12 }]);

  for (let i = 0; i < 20; i++) h.db.seed('questions', { id: v7(300 + i), subject_id: SHARED, node_id: SHARED_TOPIC, type: 'true_false', stem: 'x', payload: {}, origin: 'peer', author_id: BOB.id, review_status: 'pending', status: 'active', deleted_at: null, created_at: new Date().toISOString() });
  const limited = await peerCreate(request('peer-question-create', { token: BOB.jwt, body: question, idem: v7(3) }), h.deps);
  assertEquals(limited.status, 429);
  const personal = await peerCreate(request('peer-question-create', { body: { ...question, subject_id: IDS.subject, node_id: IDS.topic }, idem: v7(4) }), h.deps);
  assertEquals(personal.status, 400);
  assertEquals(duplicateQuery('A fotossíntese ocorre na mitocôndria?'), 'fotossintese or ocorre or mitocondria');
});

test('Chefão: quiz-create mixes the unit topics; quiz-submit records the attempt once; another member\'s personal question is never served', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const UNIT: string = 'a0000000-0000-4000-8000-0000000000b1';
  const T2: string = 'a0000000-0000-4000-8000-0000000000b2';
  h.db.seed('knowledge_nodes', [
    { id: UNIT, subject_id: IDS.subject, parent_id: null, kind: 'unit', title: 'Energia', summary: null, learning_objectives: [], key_terms: [], formulas: [], deleted_at: null, position: 0 },
    { id: T2, subject_id: IDS.subject, parent_id: UNIT, kind: 'topic', title: 'Respiração', summary: null, learning_objectives: [], key_terms: [], formulas: [], deleted_at: null, position: 1 },
  ]);
  h.db.table('knowledge_nodes').find((n) => n.id === IDS.topic)!.parent_id = UNIT;
  for (let i = 0; i < 14; i++) h.db.seed('questions', { ...mcq(v7(400 + i), 'A', i % 2 ? (IDS.topic as string) : T2), review_status: 'approved', personal_for_user_id: null });
  h.db.seed('questions', { ...mcq(v7(499), 'A', IDS.topic), review_status: 'approved', personal_for_user_id: BOB.id });

  const res = await quizCreate(request('quiz-create', { body: { kind: 'boss', scope: { unit_node_id: UNIT }, count: 10, mode: 'practice' }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 201, await res.clone().text());
  const created = await json(res);
  assertEquals(created.question_ids.length, 10);
  assert(!created.question_ids.includes(v7(499)));
  const quiz = h.db.rows('quizzes').find((q) => q.id === created.quiz_id)!;
  assertEquals(quiz.title, 'Chefão: Energia');

  const answers = (created.question_ids as string[]).map((q, i) => ({ id: v7(600 + i), question_id: q, response: { choice: i < 8 ? 'A' : 'B' }, time_spent_ms: 10_000 }));
  const submitted = await quizSubmit(request('quiz-submit', { body: { attempt_id: created.attempt_id, answers, finished_at: '2026-10-27T17:00:00Z' }, idem: v7(2) }), h.deps);
  assertEquals(submitted.status, 200, await submitted.clone().text());
  const boss = h.db.rows('boss_attempts');
  assertEquals(boss.length, 1);
  assertEquals([boss[0]!.passed, boss[0]!.score, boss[0]!.unit_node_id], [true, 0.8, UNIT]);

  // A retry prefers questions not seen in the first boss.
  const retry = await json(await quizCreate(request('quiz-create', { body: { kind: 'boss', scope: { unit_node_id: UNIT }, count: 10, mode: 'practice' }, idem: v7(3) }), h.deps));
  assertEquals((retry.question_ids as string[]).filter((q) => !(created.question_ids as string[]).includes(q)).length, 4);

  const notUnit = await quizCreate(request('quiz-create', { body: { kind: 'boss', scope: { unit_node_id: IDS.topic }, count: 10, mode: 'practice' }, idem: v7(4) }), h.deps);
  assertEquals(notUnit.status, 400);
});
