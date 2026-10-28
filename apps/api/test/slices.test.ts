import { test } from 'bun:test';
// prepareSlices reuses document_slices rows written by the worker as well as by the API.
import { assertEquals } from './assert.ts';
import { makeHarness, makePdf } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { prepareSlices } from '../src/shared/slices.ts';

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
