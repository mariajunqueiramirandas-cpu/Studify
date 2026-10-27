// tutor-chat: streamed citations carry ORIGINAL page numbers, the budget gate stops before any Claude call,
// a second turn replays the first turn's documents, and another student's thread is not found.
import { assert, assertEquals } from '@std/assert';
import { ALICE, BOB, makeHarness, parseSse, pageCitation, request, json } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler } from '../tutor-chat/index.ts';

const ANSWER = {
  content: [
    {
      type: 'text',
      text: 'A fotossíntese usa a clorofila para captar luz.',
      citations: [pageCitation(0, 2, 'a clorofila capta luz')],
    },
  ],
};

function ask(body: Record<string, unknown>, token?: string) {
  return request('tutor-chat', { token, idem: '0190a000-0000-7000-8000-0000000000e1', body });
}

Deno.test('tutor-chat: streams deltas and citations mapped to the original page numbers', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  const res = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'O que é fotossíntese?', client_message_id: v7(40) }), h.deps);
  assertEquals(res.status, 200);
  assert((res.headers.get('content-type') ?? '').startsWith('text/event-stream'));
  const frames = parseSse(await res.text());
  assertEquals(frames[0]?.event, 'meta');
  const meta = frames[0]!.data as { thread_id: string; message_id: string };
  assert(meta.thread_id && meta.message_id);
  assert(frames.some((f) => f.event === 'delta'));
  const citation = frames.find((f) => f.event === 'citation')!.data as { page_start: number; page_end: number; document_id: string };
  // Slice pages are 12, 13, 14 (original). The model cited slice page 2, which is original page 13.
  assertEquals(citation.page_start, 13);
  assertEquals(citation.document_id, IDS.doc);
  const done = frames.at(-1)!;
  assertEquals(done.event, 'done');
  assertEquals((done.data as { stop_reason: string }).stop_reason, 'end_turn');
  assertEquals(((done.data as { result: { citations: Array<{ page_start: number }> } }).result.citations)[0]?.page_start, 13);

  // The document block sent to Claude is labelled with the original pages it contains.
  const sent = h.claude.calls[0]!.params as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const docBlock = sent.messages.at(-1)!.content.find((b) => b.type === 'document') as { title: string; citations: unknown };
  assert(docBlock.title.includes('páginas originais 12–14'), docBlock.title);
  assertEquals(docBlock.citations, { enabled: true });

  // Both messages are stored with raw_content for replay.
  const stored = h.db.rows('tutor_messages');
  assertEquals(stored.map((m) => m.role), ['user', 'assistant']);
  assert(Array.isArray(stored[1]!.raw_content));
  assertEquals(h.db.rows('tutor_threads')[0]?.user_id, ALICE.id);
});

Deno.test('tutor-chat: a second turn replays the first turn’s document from storage', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  const first = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'O que é fotossíntese?', client_message_id: v7(41) }), h.deps);
  const threadId = (parseSse(await first.text())[0]!.data as { thread_id: string }).thread_id;
  const second = await handler(ask({ thread_id: threadId, mode: 'answer', message: 'E a clorofila?', client_message_id: v7(42) }), h.deps);
  assertEquals(second.status, 200);
  const frames = parseSse(await second.text());
  assertEquals(frames.at(-1)?.event, 'done');
  const sent = h.claude.calls[1]!.params as { messages: Array<{ role: string; content: unknown }> };
  const firstUser = sent.messages.find((m) => m.role === 'user')!;
  const blocks = firstUser.content as Array<{ type: string; source?: { type: string; data: string } }>;
  const replayedDoc = blocks.find((b) => b.type === 'document');
  assert(replayedDoc, 'the earlier turn keeps its document block');
  assertEquals(replayedDoc.source?.type, 'base64');
  assert((replayedDoc.source?.data ?? '').length > 100, 'bytes come back from storage');
  // The assistant turn of the first answer is replayed verbatim.
  assert(sent.messages.some((m) => m.role === 'assistant'));
});

Deno.test('tutor-chat: budget exhausted → 402 budget_exhausted and no Claude call', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  h.budget.refuse = 'user_day';
  const res = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'O que é fotossíntese?', client_message_id: v7(43) }), h.deps);
  assertEquals(res.status, 402);
  const body = await json(res);
  assertEquals(body.error.code, 'budget_exhausted');
  assertEquals(body.error.resets_at, '2026-10-28T00:00:00-03:00');
  assertEquals(h.claude.calls.length, 0);
  assertEquals(h.db.rows('tutor_messages').length, 0, 'nothing is stored for a refused turn');
});

Deno.test('tutor-chat: another student’s subject or thread is not found', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  const foreignSubject = await handler(ask({ scope: { type: 'subject', subject_id: IDS.bobSubject }, mode: 'answer', message: 'Oi', client_message_id: v7(44) }), h.deps);
  assertEquals(foreignSubject.status, 404);
  h.db.seed('tutor_threads', { id: v7(45), user_id: BOB.id, scope_type: 'subject', subject_id: IDS.bobSubject, mode: 'answer', context_pages: [], archived_at: null });
  const foreignThread = await handler(ask({ thread_id: v7(45), mode: 'answer', message: 'Oi', client_message_id: v7(46) }), h.deps);
  assertEquals(foreignThread.status, 404);
  assertEquals(h.claude.calls.length, 0);
});

Deno.test('tutor-chat: the daily message limit is 60 per student (402) and nothing is called', async () => {
  const h = makeHarness(ANSWER);
  await seedWorld(h);
  for (let i = 0; i < 60; i += 1) {
    h.db.seed('tutor_messages', { id: v7(1000 + i), thread_id: v7(999), user_id: ALICE.id, role: 'user', content: 'x', created_at: '2026-10-27T14:00:00Z' });
  }
  const res = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'Mais uma', client_message_id: v7(47) }), h.deps);
  assertEquals(res.status, 402);
  assertEquals(h.claude.calls.length, 0);
});

Deno.test('tutor-chat: a refusal ends the stream as refusal and stores nothing', async () => {
  const h = makeHarness({ content: [], stop_reason: 'refusal', stop_details: { category: 'bio' } });
  await seedWorld(h);
  const res = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'Vírus', client_message_id: v7(48) }), h.deps);
  const frames = parseSse(await res.text());
  assertEquals((frames.at(-1)!.data as { stop_reason: string }).stop_reason, 'refusal');
  assertEquals(h.db.rows('tutor_messages').length, 0);
});

Deno.test('tutor-chat: the distress marker is removed from the streamed text and flags the message', async () => {
  const h = makeHarness({ content: [{ type: 'text', text: 'Sinto muito. [[APOIO]]' }], stop_reason: 'end_turn' });
  await seedWorld(h);
  const res = await handler(ask({ scope: { type: 'subject', subject_id: IDS.subject }, mode: 'answer', message: 'Estou mal', client_message_id: v7(49) }), h.deps);
  const text = await res.text();
  assert(!text.includes('[[APOIO]]'));
  const assistant = h.db.rows('tutor_messages').find((m) => m.role === 'assistant')!;
  assertEquals(assistant.safety_flag, 'distress');
});
