import { expect, test } from 'bun:test';
import { SseOperation, SseWriter } from '../src/shared/sse.ts';
import { parseSse } from './fakes.ts';

test('a slow subscriber is detached without stopping a fast subscriber or the producer', async () => {
  const writer = new SseWriter();
  const slow = writer.subscribe();
  const fast = writer.subscribe().body!.getReader();
  await fast.read(); // connection comment
  for (let i = 0; i < 24; i++) {
    writer.send('delta', { text: 'x'.repeat(32 * 1024) });
    const chunk = await fast.read();
    expect(chunk.done).toBe(false);
  }
  writer.send('done', { result: 'finished' });
  expect(new TextDecoder().decode((await fast.read()).value)).toContain('event: done');
  writer.close();
  expect((await fast.read()).done).toBe(true);
  await expect(slow.text()).rejects.toThrow('too slow');
});

test('settlement completes before EOF and a stream has one terminal event', async () => {
  let persisted!: () => void;
  const gate = new Promise<void>((resolve) => { persisted = resolve; });
  const operation = new SseOperation({ heartbeatMs: 0, onSettled: async () => { await gate; } }, async (writer) => {
    writer.send('done', { result: 42 });
    writer.send('delta', { text: 'ignored after terminal event' });
  });
  const reader = operation.writer.subscribe().body!.getReader();
  await reader.read();
  const frame = new TextDecoder().decode((await reader.read()).value);
  expect(parseSse(frame).map((event) => event.event)).toEqual(['done']);
  let ended = false;
  const eof = reader.read().then((chunk) => { ended = true; return chunk; });
  await Promise.resolve();
  expect(ended).toBe(false);
  persisted(); await operation.done;
  expect((await eof).done).toBe(true);
});

test('heartbeats do not enter the persisted transcript or advance event IDs', () => {
  const writer = new SseWriter();
  writer.send('meta', { request_id: 'test' });
  writer.comment('ping');
  writer.send('done', {});
  expect(writer.transcript).not.toContain(': ping');
  expect(writer.transcript).toContain('id: 1\nevent: meta');
  expect(writer.transcript).toContain('id: 2\nevent: done');
  writer.close();
});
