import { test } from 'bun:test';
// prepareSlices reuses document_slices rows written by the worker as well as by the API.
import { assertEquals } from './assert.ts';
import { ALICE, makeHarness, makePdf } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { prepareSlices } from '../src/shared/slices.ts';
import { loadTopic, topicSlices } from '../src/shared/topic.ts';
import { documentBlocks } from '@studify/prompts';

test('prepareSlices: a worker slice path without the bucket prefix is read from the slices bucket', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const bytes = await makePdf(2);
  // The worker stores paths relative to the `slices` bucket (before: invalid_request, so the Trilha never started).
  h.db.seed('document_slices', { id: v7(40), document_id: IDS.doc, purpose: 'topic', page_start: 2, page_end: 3, storage_path: `${IDS.doc}/2-3.pdf` });
  h.db.objects.set(`slices/${IDS.doc}/2-3.pdf`, bytes);
  const [slice] = await prepareSlices(h.deps.db, {
    documentId: IDS.doc,
    title: 'Apostila de biologia',
    storagePath: `documents/${IDS.subject}/${IDS.doc}.pdf`,
    pages: [2, 3],
    purpose: 'topic',
    newId: () => v7(41),
  });
  assertEquals(slice?.storagePath, `slices/${IDS.doc}/2-3.pdf`);
  assertEquals(slice?.base64, Buffer.from(bytes).toString('base64'));
});

test('topicSlices: the topic pages go with one page of context on each side, marked as such', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const bundle = await loadTopic(h.deps.db, ALICE.id, IDS.topic);
  const { slices, prepared } = await topicSlices(h.deps, bundle);
  // The topic is pages 12–14 of a 40-page document.
  assertEquals(prepared.map((p) => p.pages), [[11, 12, 13, 14, 15]]);
  assertEquals(prepared[0]?.focusPages, [12, 13, 14]);
  const block = documentBlocks(slices).blocks[0];
  assertEquals(block?.title, 'Documento D1 — Apostila de biologia — páginas originais 11–15 (do tópico: 12–14)');
  assertEquals(block?.context?.startsWith('O conteúdo deste tópico está nas páginas 12–14.'), true);
});
