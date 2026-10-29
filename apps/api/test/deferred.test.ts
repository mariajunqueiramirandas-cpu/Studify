import { expect, test } from 'bun:test';
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { ALICE, BOB, makeHarness, parseSse, request as plainRequest, withUsers } from './fakes.ts';
import { v7 } from './world.ts';
import { defineFunction } from '../src/shared/http.ts';
import { drainOperations } from '../src/shared/operations.ts';

const request = (path: string, opts: Parameters<typeof plainRequest>[1] = {}) =>
  plainRequest(path, { ...opts, headers: { accept: 'text/event-stream', ...opts.headers } });
const harness = () => { const h = makeHarness(); withUsers(h); return h; };
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

test('opens and flushes SSE before structured AI work finishes; delivers its result on the same connection', async () => {
  const h = harness(); const pause = gate();
  const handler = defineFunction({ name: 'stream-result', mutating: true, streamResult: true,
    input: z.object({ n: z.number() }), run: async (ctx) => { await pause.wait; return ctx.json({ n: ctx.input.n * 2 }, 201); } });
  const res = await handler(request('stream-result', { idem: v7(9001), body: { n: 21 } }), h.deps);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(res.headers.get('x-accel-buffering')).toBe('no');
  const reader = res.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
  pause.release();
  let text = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  expect(parseSse(text).find((event) => event.event === 'done')?.data).toMatchObject({ result: { n: 42 }, status: 201 });
  expect(h.enqueued).toHaveLength(0);
});

test('simultaneous repeats join live work; completed calls replay without generating again', async () => {
  const h = harness(); const pause = gate(); let calls = 0;
  const handler = defineFunction({ name: 'stream-join', mutating: true, streamResult: true,
    run: async (ctx) => { calls++; await pause.wait; return ctx.json({ ok: true }); } });
  const args = { idem: v7(9101), body: { n: 1 } };
  const [first, second] = await Promise.all([handler(request('stream-join', args), h.deps), handler(request('stream-join', args), h.deps)]);
  pause.release();
  expect(parseSse(await first.text()).map((event) => event.event)).toEqual(['meta', 'done']);
  expect(parseSse(await second.text()).map((event) => event.event)).toEqual(['meta', 'done']);
  await drainOperations(h.deps);
  const replay = await handler(request('stream-join', args), h.deps);
  expect(replay.headers.get('idempotent-replayed')).toBe('true');
  expect(parseSse(await replay.text()).at(-1)?.data).toMatchObject({ result: { ok: true } });
  expect(calls).toBe(1);
});

test('new keys for identical active AI work join and each key becomes replayable', async () => {
  const h = harness(); const pause = gate(); let calls = 0;
  const handler = defineFunction({ name: 'stream-double-tap', mutating: true, streamResult: true,
    run: async (ctx) => { calls++; await pause.wait; return ctx.json({ user: ctx.user.userId }); } });
  const first = await handler(request('stream-double-tap', { idem: v7(9201) }), h.deps);
  const second = await handler(request('stream-double-tap', { idem: v7(9202) }), h.deps);
  pause.release(); await Promise.all([first.text(), second.text()]); await drainOperations(h.deps);
  const replay = await handler(request('stream-double-tap', { idem: v7(9202) }), h.deps);
  expect(replay.headers.get('idempotent-replayed')).toBe('true');
  expect(calls).toBe(1);
});

test('same-key body mismatch fails; different students never join', async () => {
  const h = harness(); const pause = gate(); const users: string[] = [];
  const handler = defineFunction({ name: 'stream-isolation', mutating: true, streamResult: true,
    run: async (ctx) => { users.push(ctx.user.userId); await pause.wait; return ctx.json({ ok: true }); } });
  const first = await handler(request('stream-isolation', { idem: v7(9301), body: { n: 1 } }), h.deps);
  expect((await handler(request('stream-isolation', { idem: v7(9301), body: { n: 2 } }), h.deps)).status).toBe(409);
  const other = await handler(request('stream-isolation', { idem: v7(9301), body: { n: 1 }, token: BOB.jwt }), h.deps);
  pause.release(); await Promise.all([first.text(), other.text()]);
  expect(users.sort()).toEqual([ALICE.id, BOB.id].sort());
});

test('disconnect/reconnect resumes the live stream after Last-Event-ID, without waiting for completion', async () => {
  const h = harness(); const pause = gate(); let calls = 0;
  const handler = defineFunction({ name: 'stream-resume', mutating: true,
    run: async (ctx) => ctx.sse(async (writer) => {
      calls++; writer.send('delta', { text: 'first' }); await pause.wait;
      writer.send('delta', { text: 'second' }); writer.send('done', { result: 'complete' });
    }) });
  const args = { idem: v7(9401) };
  const first = await handler(request('stream-resume', args), h.deps);
  const reader = first.body!.getReader(); await reader.read(); await reader.cancel();
  const resumed = await handler(request('stream-resume', { ...args, headers: { 'Last-Event-ID': '2' } }), h.deps);
  expect(resumed.status).toBe(200);
  pause.release();
  expect(parseSse(await resumed.text()).map((event) => event.event)).toEqual(['delta', 'done']);
  await drainOperations(h.deps);
  const replay = await handler(request('stream-resume', { ...args, headers: { 'Last-Event-ID': '2' } }), h.deps);
  expect(parseSse(await replay.text()).map((event) => event.event)).toEqual(['delta', 'done']);
  expect(calls).toBe(1);
});

test('terminal failures preserve their code and replay without a second paid attempt', async () => {
  const h = harness(); let calls = 0;
  const handler = defineFunction({ name: 'stream-failure', mutating: true, streamResult: true,
    run: async () => { calls++; throw new ApiFailure('budget_exhausted'); } });
  const args = { idem: v7(9501) };
  const first = await handler(request('stream-failure', args), h.deps);
  expect(parseSse(await first.text()).at(-1)).toMatchObject({ event: 'error', data: { code: 'budget_exhausted' } });
  const replay = await handler(request('stream-failure', args), h.deps);
  expect(parseSse(await replay.text()).at(-1)).toMatchObject({ event: 'error', data: { code: 'budget_exhausted' } });
  expect(calls).toBe(1);
});

test('authentication and schema errors remain HTTP errors before any stream opens', async () => {
  const h = harness(); let calls = 0;
  const handler = defineFunction({ name: 'stream-validation', mutating: true, input: z.object({ n: z.number() }),
    run: async (ctx) => { calls++; return ctx.json({ ok: true }); } });
  expect((await handler(request('stream-validation', { token: null }), h.deps)).status).toBe(401);
  expect((await handler(request('stream-validation', { body: { n: 'bad' } }), h.deps)).status).toBe(400);
  expect(calls).toBe(0);
});

test('real HTTP connection receives bytes while the operation is still waiting for its result', async () => {
  const h = harness(); const pause = gate();
  const handler = defineFunction({ name: 'wire-stream', mutating: true, streamResult: true,
    run: async (ctx) => { await pause.wait; return ctx.json({ ready: true }); } });
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req, h.deps) });
  try {
    const req = request('wire-stream', { idem: v7(9901) });
    const response = await fetch(`http://127.0.0.1:${server.port}/wire-stream`, { method: 'POST', headers: req.headers, body: '{}' });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(': connected');
    pause.release();
    while (!(await reader.read()).done) { /* drain the actual HTTP body */ }
  } finally { pause.release(); await server.stop(true); }
});
