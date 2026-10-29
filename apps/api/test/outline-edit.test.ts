import { test } from 'bun:test';
// outline-edit (ING-04): the outline RPC runs as the student, and every topic it reports for regeneration is
// queued as content.regenerate_topic (the worker's payload: node_id, user_id).
import { assertEquals } from './assert.ts';
import { ALICE, makeHarness, request, json } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler } from '../src/functions/outline-edit.ts';

const merge = { op: 'merge', node_ids: [IDS.topic, IDS.concept], title: 'Fotossíntese e clorofila' };

test('outline-edit: the RPC runs as the student and each reported topic is queued for regeneration', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const newTopic = v7(700);
  h.db.rpcs.set('edit_outline', () => ({ data: { event_ids: [v7(701)], regenerate_node_ids: [newTopic, IDS.topic] } }));
  const res = await handler(request('outline-edit', { idem: v7(702), body: { subject_id: IDS.subject, ops: [merge] } }), h.deps);
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.event_ids, [v7(701)]);
  assertEquals(body.regenerate_node_ids, [newTopic, IDS.topic]);

  const call = h.db.rpcCalls.find((c) => c.name === 'edit_outline');
  assertEquals(call?.args.p_subject_id, IDS.subject);
  assertEquals(call?.args.p_ops, [merge]);

  const queued = h.enqueued.filter((e) => e.queue === 'content.regenerate_topic');
  assertEquals(queued.map((e) => e.data.node_id), [newTopic, IDS.topic]);
  assertEquals(queued[0]?.data.user_id, ALICE.id);
  // Minutes of AI work per topic: never inside the request (ADR 0011).
  assertEquals(queued.map((e) => e.options?.startAfterSeconds), [0, 0]);
});

test('outline-edit: an operation that is not valid is rejected before the RPC runs', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const res = await handler(request('outline-edit', { idem: v7(703), body: { subject_id: IDS.subject, ops: [{ op: 'merge', node_ids: [IDS.topic], title: 'só um' }] } }), h.deps);
  assertEquals(res.status, 400);
  assertEquals(h.db.rpcCalls.length, 0);
  assertEquals(h.enqueued.length, 0);
});

test('outline-edit: a refused edit queues nothing', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.rpcs.set('edit_outline', () => ({ data: null, error: { message: 'Você não pode editar esse conteúdo', code: 'P0001', hint: 'forbidden' } }));
  const res = await handler(request('outline-edit', { idem: v7(704), body: { subject_id: IDS.bobSubject, ops: [merge] } }), h.deps);
  assertEquals(res.status, 403);
  assertEquals(h.enqueued.length, 0);
});
