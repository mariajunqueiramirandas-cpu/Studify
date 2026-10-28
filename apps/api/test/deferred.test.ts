import { test } from 'bun:test';
// ADR 0009: deferred calls and running repeats. A deferred call answers `202 running` at once and runs as a job; every
// repeat with the same key is a status check until the job stores the answer, which the next repeat replays. A
// repeat of a call that is still running is never a 409, and a stream whose client went away still finishes.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, parseSse, request as plainRequest, withUsers } from './fakes.ts';
import { v7 } from './world.ts';
import { defineFunction, OPERATION_STATUS_HEADER, runDeferred } from '../src/shared/http.ts';
import type { DeferredJob } from '../src/shared/deps.ts';

const doubled = defineFunction<{ n: number }>({
  name: 'test-deferred-double',
  mutating: false,
  deferred: true,
  input: z.object({ n: z.number() }),
  run: async (ctx) => ctx.json({ doubled: ctx.input.n * 2, user: ctx.user.userId }, 201),
});

let failures: ApiFailure[] = [];
const flaky = defineFunction<{ n: number }>({
  name: 'test-deferred-flaky',
  mutating: true,
  deferred: true,
  input: z.object({ n: z.number() }),
  run: async (ctx) => {
    const next = failures.shift();
    if (next) throw next;
    return ctx.json({ ok: ctx.input.n });
  },
});

function harness() {
  const h = makeHarness();
  withUsers(h);
  const jobs: DeferredJob[] = [];
  h.deps.defer = async (job) => void jobs.push(job);
  return { h, jobs };
}

/** A request from an app build that follows running calls (ADR 0009). */
const request = (path: string, opts: Parameters<typeof plainRequest>[1] = {}) =>
  plainRequest(path, { ...opts, headers: { 'x-studify-operations': '1', ...(opts.headers ?? {}) } });

const isRunning = (res: Response) => res.status === 202 && res.headers.get(OPERATION_STATUS_HEADER) === 'running';

test('deferred call: 202 running at once, then the stored answer on the next repeat', async () => {
  const { h, jobs } = harness();
  const key = v7(9001);
  const first = await doubled(request('test-deferred-double', { idem: key, body: { n: 21 } }), h.deps);
  assert(isRunning(first), 'the request does not wait for the work');
  assertEquals(first.headers.get('retry-after'), '1');
  assertEquals(await json(first), { status: 'running', operation_key: key });
  assertEquals(jobs.length, 1);
  assertEquals({ fn: jobs[0]!.fn, user: jobs[0]!.user_id, key: jobs[0]!.key }, { fn: 'test-deferred-double', user: ALICE.id, key });

  assert(isRunning(await doubled(request('test-deferred-double', { idem: key, body: { n: 21 } }), h.deps)), 'still running before the job ran');
  assertEquals(jobs.length, 1, 'a repeat queues nothing');

  const stored = await runDeferred(jobs[0]!, h.deps, { finalAttempt: false });
  assertEquals(stored.status, 201);

  const done = await doubled(request('test-deferred-double', { idem: key, body: { n: 21 } }), h.deps);
  assertEquals(done.status, 201);
  assertEquals(done.headers.get('Idempotent-Replayed'), 'true');
  assertEquals(await json(done), { doubled: 42, user: ALICE.id });
});

test('deferred call: an identical call while the first runs joins it; another body or student does not', async () => {
  const { h, jobs } = harness();
  const original = v7(9101);
  await doubled(request('test-deferred-double', { idem: original, body: { n: 5 } }), h.deps);

  const repeat = await doubled(request('test-deferred-double', { idem: v7(9102), body: { n: 5 } }), h.deps);
  assert(isRunning(repeat));
  assertEquals((await json(repeat)).operation_key, original, 'the app follows the running call');
  assertEquals(jobs.length, 1, 'no second job for the same work');

  await doubled(request('test-deferred-double', { idem: v7(9103), body: { n: 6 } }), h.deps);
  await doubled(request('test-deferred-double', { idem: v7(9104), body: { n: 5 }, token: BOB.jwt }), h.deps);
  assertEquals(jobs.length, 3);

  await runDeferred(jobs[0]!, h.deps, { finalAttempt: false });
  const later = await doubled(request('test-deferred-double', { idem: v7(9105), body: { n: 5 } }), h.deps);
  assert(isRunning(later), 'after the first finished, the same body is a new call');
  assertEquals((await json(later)).operation_key, v7(9105));
  assertEquals(jobs.length, 4);
});

test('deferred call: a server error is retried by the queue, and the last attempt stores it for the app', async () => {
  const { h, jobs } = harness();
  failures = [new ApiFailure('ai_unavailable'), new ApiFailure('ai_unavailable')];
  const key = v7(9201);
  await flaky(request('test-deferred-flaky', { idem: key, body: { n: 1 } }), h.deps);

  let threw = false;
  await runDeferred(jobs[0]!, h.deps, { finalAttempt: false }).catch(() => (threw = true));
  assert(threw, 'not the last attempt: rethrown so pg-boss retries');
  assert(isRunning(await flaky(request('test-deferred-flaky', { idem: key, body: { n: 1 } }), h.deps)), 'the app keeps waiting');

  const stored = await runDeferred(jobs[0]!, h.deps, { finalAttempt: true });
  assertEquals(stored.status, 503);
  const res = await flaky(request('test-deferred-flaky', { idem: key, body: { n: 1 } }), h.deps);
  assertEquals(res.status, 503);
  assertEquals((await json(res)).error.code, 'ai_unavailable');
});

test('deferred call: a client error is stored on the first attempt', async () => {
  const { h, jobs } = harness();
  failures = [new ApiFailure('invalid_request', { message: 'Não dá.' })];
  const key = v7(9301);
  await flaky(request('test-deferred-flaky', { idem: key, body: { n: 1 } }), h.deps);
  const stored = await runDeferred(jobs[0]!, h.deps, { finalAttempt: false });
  assertEquals(stored.status, 400);
  const res = await flaky(request('test-deferred-flaky', { idem: key, body: { n: 1 } }), h.deps);
  assertEquals((await json(res)).error.message, 'Não dá.');
});

test('deferred call: without a queue (deps.defer unset) the handler runs inline', async () => {
  const h = makeHarness();
  withUsers(h);
  const res = await doubled(request('test-deferred-double', { idem: v7(9401), body: { n: 2 } }), h.deps);
  assertEquals(res.status, 201);
  assertEquals((await json(res)).doubled, 4);
});

test('a repeat of a mutating call that is still running answers 202 running, never 409', async () => {
  const h = makeHarness();
  withUsers(h);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = defineFunction<{ n: number }>({
    name: 'test-slow-inline',
    mutating: true,
    input: z.object({ n: z.number() }),
    run: async (ctx) => {
      await gate;
      return ctx.json({ n: ctx.input.n });
    },
  });
  const key = v7(9501);
  const original = slow(request('test-slow-inline', { idem: key, body: { n: 7 } }), h.deps);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeat = await slow(request('test-slow-inline', { idem: key, body: { n: 7 } }), h.deps);
  assert(isRunning(repeat), `expected 202 running, got ${repeat.status}`);
  release();
  assertEquals((await original).status, 200);
  const replay = await slow(request('test-slow-inline', { idem: key, body: { n: 7 } }), h.deps);
  assertEquals(await json(replay), { n: 7 });
});

test('a stream whose client disconnects still finishes, and the reconnect replays all of it', async () => {
  const h = makeHarness();
  withUsers(h);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let finished!: () => void;
  const settled = new Promise<void>((resolve) => (finished = resolve));
  const streamed = defineFunction<{ q: string }>({
    name: 'test-stream-detach',
    mutating: true,
    input: z.object({ q: z.string() }),
    run: async (ctx) =>
      ctx.sse(async (writer) => {
        writer.send('meta', { request_id: ctx.requestId });
        await gate;
        writer.send('delta', { text: 'resposta inteira' });
        writer.send('done', { stop_reason: 'end_turn' });
        setTimeout(finished, 0);
      }),
  });
  const key = v7(9601);
  const res = await streamed(request('test-stream-detach', { idem: key, body: { q: 'oi' } }), h.deps);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();

  const whileRunning = await streamed(request('test-stream-detach', { idem: key, body: { q: 'oi' } }), h.deps);
  assert(isRunning(whileRunning), 'the reconnect waits instead of failing');

  release();
  await settled;
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const replay = await streamed(request('test-stream-detach', { idem: key, body: { q: 'oi' } }), h.deps);
  assertEquals(replay.status, 200);
  assertEquals(
    parseSse(await replay.text()).map((f) => f.event),
    ['meta', 'delta', 'done'],
  );
});

test('an older app build (no x-studify-operations) keeps the old contract: inline call, 409 while running', async () => {
  const { h, jobs } = harness();
  const res = await doubled(plainRequest('test-deferred-double', { idem: v7(9701), body: { n: 3 } }), h.deps);
  assertEquals(res.status, 201, 'it would read a 202 running as the final answer');
  assertEquals(jobs.length, 0);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = defineFunction<{ n: number }>({
    name: 'test-slow-old-client',
    mutating: true,
    input: z.object({ n: z.number() }),
    run: async (ctx) => {
      await gate;
      return ctx.json({ n: ctx.input.n });
    },
  });
  const key = v7(9702);
  const original = slow(plainRequest('test-slow-old-client', { idem: key, body: { n: 1 } }), h.deps);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeat = await slow(plainRequest('test-slow-old-client', { idem: key, body: { n: 1 } }), h.deps);
  assertEquals(repeat.status, 409);
  release();
  await original;
});
