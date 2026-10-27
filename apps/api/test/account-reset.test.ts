import { test } from 'bun:test';
// account-reset: re-authentication, the private.reset_account call, the file cleanup job, the Turma-owner refusal.
import { assert, assertEquals } from './assert.ts';
import { makeHarness, request, json } from './fakes.ts';
import { seedWorld, v7 } from './world.ts';
import { handler as accountReset } from '../src/functions/account-reset.ts';

test('account-reset: a wrong email code is refused and nothing is reset', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.otpCode = '123456';
  h.db.rpcs.set('reset_account', () => ({ data: { documents: [], exports: [] } }));
  const res = await accountReset(request('account-reset', { idem: v7(700), body: { otp_code: '000000' } }), h.deps);
  assertEquals(res.status, 403);
  assertEquals(h.db.rpcCalls.filter((c) => c.name === 'reset_account').length, 0);
});

test('account-reset: the right code resets in the private schema and queues the file cleanup', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.otpCode = '123456';
  const documents = [{ id: v7(702), storage_path: 'subject/doc.pdf' }];
  h.db.rpcs.set('reset_account', () => ({ data: { documents, exports: ['user/export.zip'] } }));
  const res = await accountReset(request('account-reset', { idem: v7(701), body: { otp_code: '123456' } }), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await json(res)).reset, true);
  const call = h.db.rpcCalls.find((c) => c.name === 'reset_account')!;
  assertEquals(call.schema, 'private');
  assert(typeof call.args.p_user === 'string' && call.args.p_user.length > 0, 'resets the caller');
  const job = h.enqueued.find((e) => e.queue === 'account.reset_files')!;
  assertEquals(job.data.documents, documents);
  assertEquals(job.data.exports, ['user/export.zip']);
});

test('account-reset: a Turma owner is told to transfer the Turma first', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.otpCode = '123456';
  h.db.rpcs.set('reset_account', () => ({ error: { message: 'owner_transfer_required', code: 'P0001' } }));
  const res = await accountReset(request('account-reset', { idem: v7(703), body: { otp_code: '123456' } }), h.deps);
  assertEquals(res.status, 403);
  assert(String((await json(res)).error.message).includes('turma'));
  assertEquals(h.enqueued.filter((e) => e.queue === 'account.reset_files').length, 0);
});
