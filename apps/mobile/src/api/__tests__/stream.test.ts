/// <reference types="jest" />
// Exercise the real reader and reconnect protocol with Web streams, including UTF-8 packet boundaries.
import { ReadableStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';
import { receiveStream } from '../transport';
import { ApiError } from '../errors';

Object.assign(globalThis, { TextEncoder, TextDecoder });
const frame = (id: number, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const encode = (text: string) => new TextEncoder().encode(text);
function response(chunks: Uint8Array[], drop = false): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (drop) controller.error(new TypeError('connection reset'));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body } as unknown as Response;
}

describe('SSE streaming transport', () => {
  it('decodes multibyte Portuguese and emoji split at every byte', async () => {
    const bytes = encode(frame(1, 'delta', { text: 'Olá 🧠' }) + frame(2, 'done', { result: 42 }));
    const events: unknown[] = [];
    await receiveStream({ send: async () => response(Array.from(bytes, (byte) => new Uint8Array([byte]))), onEvent: (event) => events.push(event) });
    expect(events).toEqual([{ event: 'delta', data: { text: 'Olá 🧠' } }, { event: 'done', data: { result: 42 } }]);
  });
  it('reconnects with Last-Event-ID and suppresses duplicates in a full replay', async () => {
    const sent: (string | undefined)[] = [];
    const events: string[] = [];
    await receiveStream({
      send: async (last) => {
        sent.push(last);
        if (sent.length === 1) return response([encode(frame(1, 'delta', { text: 'first' }))], true);
        return response([encode(frame(1, 'delta', { text: 'first' }) + frame(2, 'delta', { text: 'second' }) + frame(3, 'done', {}))]);
      }, onEvent: (event) => events.push(event.event), sleep: async () => {},
    });
    expect(sent).toEqual([undefined, '1']);
    expect(events).toEqual(['delta', 'delta', 'done']);
  });
  it('resumes after a connection cuts through the middle of a frame', async () => {
    const sent: (string | undefined)[] = [];
    const events: string[] = [];
    await receiveStream({ send: async (last) => {
      sent.push(last);
      return sent.length === 1
        ? response([encode(frame(1, 'delta', { text: 'first' }) + 'id: 2\nevent: delta\ndata: {"text":"cu')])
        : response([encode(frame(2, 'delta', { text: 'complete' }) + frame(3, 'done', {}))]);
    }, onEvent: (event) => events.push(event.event), sleep: async () => {} });
    expect(sent).toEqual([undefined, '1']);
    expect(events).toEqual(['delta', 'delta', 'done']);
  });
  it('preserves a terminal error and its budget details without retrying', async () => {
    let calls = 0;
    const done = receiveStream({ send: async () => {
      calls++;
      return response([encode(frame(1, 'error', { code: 'budget_exhausted', message: 'Limite de hoje.', resets_at: 'tomorrow', details: { scope: 'user' } }))]);
    }, onEvent: () => {} });
    await expect(done).rejects.toMatchObject({ code: 'budget_exhausted', resetsAt: 'tomorrow', details: { scope: 'user' } });
    expect(calls).toBe(1);
  });
  it('does not send a pre-cancelled operation', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await expect(receiveStream({ send: async () => { calls++; throw new Error('unreachable'); }, signal: controller.signal, onEvent: () => {} })).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toBe(0);
  });
  it('treats EOF without done as a disconnect, and bounds reconnect attempts', async () => {
    let calls = 0;
    await expect(receiveStream({ send: async () => { calls++; return response([]); }, onEvent: () => {}, sleep: async () => {} })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(3);
  });
});
