import { test } from 'bun:test';
// Câmera Mágica (CAM-01…03): Step A + Step B match the photo to the student's own topic; a photo that is not
// study content is deleted at once; another student's capture is not found; the hint ladder is built once and
// never sends the answer before the last level; "Tentar responder" compares deterministically; a confirmed
// transcription becomes an essays row with the server-measured edit ratio; photos become a `photo` document.
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, parseSse, request, type FakeReply, type Harness } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as analyze } from '../src/functions/capture-analyze.ts';
import { handler as act } from '../src/functions/capture-act.ts';

const CAP = '0190a000-0000-7000-8000-00000000ca01';
const PHOTO = `photos/${ALICE.id}/${CAP}/1.jpg`;

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const UNDERSTOOD = {
  content_type: 'book_page',
  language: 'pt-BR',
  is_study_content: true,
  contains_people: false,
  transcription_md: 'A clorofila capta luz na fotossintese.',
  key_concepts: ['clorofila'],
  subject_guess: { subject_key: 'S1', confidence: 0.9 },
  detected_questions: [],
  quality_issues: [{ type: 'glare', region_hint: 'canto superior' }],
};

const LADDER = {
  question_md: 'Calcule 2 + 3.',
  trivial: false,
  quantitative: true,
  hints: [1, 2, 3, 4].map((level) => ({ level, text_md: `Dica ${level}` })),
  final_answer: '5',
  answer_format: 'numeric',
  why_others_wrong: [],
  assumptions: [],
  uncertain_step: null,
  source_pages: [],
};

function seedCapture(h: Harness, row: Record<string, unknown> = {}): void {
  h.db.objects.set(PHOTO, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  h.db.seed('camera_captures', {
    id: CAP,
    user_id: ALICE.id,
    intent: 'explain',
    subject_id: null,
    node_id: null,
    image_paths: [PHOTO],
    quality_flags: {},
    faces_blurred: false,
    content_type: null,
    language: null,
    transcription: null,
    confirmed_text: null,
    edited_ratio: null,
    detected_questions: null,
    match: null,
    result: null,
    solver: null,
    status: 'queued',
    saved: false,
    document_id: null,
    question_id: null,
    essay_id: null,
    tutor_thread_id: null,
    deleted_at: null,
    ...row,
  });
}

test('capture-analyze: Step A + Step B match the photo to the student’s topic, with the glare flag', async () => {
  const h = makeHarness(reply(UNDERSTOOD));
  await seedWorld(h);
  seedCapture(h);
  const res = await analyze(request('capture-analyze', { body: { capture_id: CAP } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.content_type, 'book_page');
  assertEquals(body.quality, { ok: false, issues: ['glare'] });
  assertEquals(body.match.subject_id, IDS.subject);
  assertEquals(body.match.node_ids, [IDS.topic]);
  assertEquals(body.match.label, 'Biologia › Fotossíntese');
  // The photo was sent as an image block and the subject list by key, never by id.
  const sent = JSON.stringify(h.claude.calls[0]!.params);
  assert(sent.includes('"type":"image"'));
  assert(!sent.includes(IDS.subject));
  const row = h.db.rows('camera_captures')[0]!;
  assertEquals(row.status, 'ready');
  assertEquals(row.node_id, IDS.topic);

  // A repeated call replays the stored analysis without paying again.
  const again = await analyze(request('capture-analyze', { body: { capture_id: CAP }, idem: v7(2) }), h.deps);
  assertEquals((await json(again)).match.node_ids, [IDS.topic]);
  assertEquals(h.claude.calls.length, 1);
});

test('capture-analyze: a photo that is not study content is deleted at once (spec 11 §8.4)', async () => {
  const h = makeHarness(reply({ ...UNDERSTOOD, is_study_content: false }));
  await seedWorld(h);
  seedCapture(h);
  const res = await analyze(request('capture-analyze', { body: { capture_id: CAP } }), h.deps);
  assertEquals(res.status, 422);
  assertEquals((await json(res)).error.code, 'photo_unreadable');
  assert(!h.db.objects.has(PHOTO));
  const row = h.db.rows('camera_captures')[0]!;
  assertEquals(row.status, 'failed');
  assert(row.deleted_at);
});

test('capture-analyze / capture-act: another student’s capture is not found', async () => {
  const h = makeHarness(reply(UNDERSTOOD));
  await seedWorld(h);
  seedCapture(h, { status: 'ready', transcription: 'x' });
  const a = await analyze(request('capture-analyze', { token: BOB.jwt, body: { capture_id: CAP } }), h.deps);
  assertEquals(a.status, 404);
  const b = await act(request('capture-act', { token: BOB.jwt, body: { capture_id: CAP, intent: 'solve', reveal: 'hint' } }), h.deps);
  assertEquals(b.status, 404);
  assertEquals(h.claude.calls.length, 0);
});

test('capture-act solve: the ladder is built once and the answer only arrives with the last level', async () => {
  const h = makeHarness(reply(LADDER));
  await seedWorld(h);
  seedCapture(h, {
    intent: 'solve',
    status: 'ready',
    content_type: 'exercise',
    transcription: 'Calcule 2 + 3.',
    detected_questions: [{ index: 0, label: '1', preview: 'Calcule 2 + 3', text_md: 'Calcule 2 + 3.', complete: true, has_figure: false }],
  });
  const first = await json(await act(request('capture-act', { body: { capture_id: CAP, intent: 'solve', reveal: 'hint' }, idem: v7(1) }), h.deps));
  assertEquals(first.hint_level, 1);
  assertEquals(first.total_levels, 4);
  assertEquals(first.hints.length, 1);
  assertEquals(first.final, undefined);
  assert(!JSON.stringify(first).includes('"5"'));

  let last: Record<string, any> = first;
  for (let i = 0; i < 3; i++) {
    last = await json(await act(request('capture-act', { body: { capture_id: CAP, intent: 'solve', reveal: 'next_hint' }, idem: v7(10 + i) }), h.deps));
  }
  assertEquals(last.hint_level, 4);
  assertEquals(last.final.answer, '5');
  assertEquals(h.claude.calls.length, 1);
  // Quantitative statement: code execution is on for the ladder (CAM-02.6, D-13).
  assert(JSON.stringify(h.claude.calls[0]!.params.tools ?? []).includes('code_execution'));

  const wrong = await json(await act(request('capture-act', { body: { capture_id: CAP, intent: 'check_answer', answer: '6' }, idem: v7(20) }), h.deps));
  assertEquals(wrong.correct, false);
  const right = await json(await act(request('capture-act', { body: { capture_id: CAP, intent: 'check_answer', answer: '5,0' }, idem: v7(21) }), h.deps));
  assertEquals(right.correct, true);
  const solver = h.db.rows('camera_captures')[0]!.solver as { attempts: unknown[] };
  assertEquals(solver.attempts.length, 2);
});

test('capture-act explain: streams the explanation and stores it for a free replay', async () => {
  const h = makeHarness({ content: [{ type: 'text', text: 'A clorofila absorve luz vermelha e azul.' }] });
  await seedWorld(h);
  seedCapture(h, { status: 'ready', content_type: 'book_page', transcription: 'clorofila', node_id: IDS.topic, subject_id: IDS.subject, match: { subject_id: IDS.subject, node_ids: [IDS.topic], confidence: 1, label: 'Biologia › Fotossíntese' } });
  const res = await act(request('capture-act', { body: { capture_id: CAP, intent: 'explain' } }), h.deps);
  const frames = parseSse(await res.text());
  assertEquals(frames[0]?.event, 'meta');
  assertEquals((frames[0]!.data as { capture_id: string }).capture_id, CAP);
  assertEquals((frames.at(-1)!.data as { result: { not_in_material: boolean } }).result.not_in_material, false);
  const again = await act(request('capture-act', { body: { capture_id: CAP, intent: 'explain' }, idem: v7(3) }), h.deps);
  const replay = parseSse(await again.text());
  assertEquals((replay.find((f) => f.event === 'delta')!.data as { text: string }).text, 'A clorofila absorve luz vermelha e azul.');
  assertEquals(h.claude.calls.length, 1);
});

test('capture-act grade_answer: the confirmed text becomes an essays row with the server’s edit ratio', async () => {
  const h = makeHarness();
  await seedWorld(h);
  seedCapture(h, { intent: 'grade_answer', status: 'ready', content_type: 'essay', transcription: 'A mitose gera duas células\nidênticas à célula-mãe.' });
  const res = await act(
    request('capture-act', {
      body: { capture_id: CAP, intent: 'grade_answer', confirmed_text: 'A meiose gera quatro células\ncom metade dos cromossomos.', question_text: 'Explique a meiose.' },
    }),
    h.deps,
  );
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.next, 'grade-essay');
  assertEquals(body.heavily_edited, true);
  const essay = h.db.rows('essays')[0]!;
  assertEquals(essay.kind, 'school_answer');
  assertEquals(essay.input_mode, 'photo');
  assertEquals((essay.prompt as { question_text: string }).question_text, 'Explique a meiose.');
  assert((essay.edited_ratio as number) > 0.15);
  assertEquals(h.db.rows('camera_captures')[0]!.essay_id, body.essay_id);
});

test('capture-act add_to_subject: photos become a photo document; people in a Turma subject need blurring', async () => {
  const h = makeHarness();
  await seedWorld(h);
  seedCapture(h, { intent: 'add_to_subject', status: 'ready', quality_flags: { contains_people: true } });
  const res = await act(request('capture-act', { body: { capture_id: CAP, intent: 'add_to_subject', subject_id: IDS.subject } }), h.deps);
  assertEquals(res.status, 202);
  const body = await json(res);
  const doc = h.db.rows('documents').find((d) => d.id === body.document_id)!;
  assertEquals(doc.kind, 'photo');
  assertEquals(h.enqueued.find((e) => e.queue === 'ingest.photos_to_pdf')?.data.image_paths, [PHOTO]);
  assertEquals(h.db.rows('camera_captures')[0]!.saved, true);

  // A Turma subject refuses unblurred people (CAM-01.7).
  const shared = '5a000000-0000-4000-8000-000000000009';
  const group = '6a000000-0000-4000-8000-000000000001';
  h.db.seed('subjects', { id: shared, owner_profile_id: null, owner_class_group_id: group, created_by: ALICE.id, name: 'Turma bio', content_language: 'pt-BR', is_language_subject: false, enem_area: null, deleted_at: null });
  h.db.seed('class_groups', { id: group, name: 'Turma', settings: {}, deleted_at: null });
  h.db.seed('class_group_members', { class_group_id: group, user_id: ALICE.id, role: 'owner', status: 'active' });
  const cap2 = '0190a000-0000-7000-8000-00000000ca02';
  h.db.seed('camera_captures', { ...h.db.rows('camera_captures')[0]!, id: cap2, document_id: null, saved: false, faces_blurred: false });
  const refused = await act(request('capture-act', { body: { capture_id: cap2, intent: 'add_to_subject', subject_id: shared }, idem: v7(5) }), h.deps);
  assertEquals(refused.status, 403);
});
