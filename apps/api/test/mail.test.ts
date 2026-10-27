// Guardian mail over Resend (SP-03): the request Resend receives, and a failed send surfacing to the caller.
import { test } from 'bun:test';
import { makeResendGuardianMail } from '../src/shared-p2/mail.ts';
import { assert, assertEquals, assertStringIncludes } from './assert.ts';

test('guardian mail: posts to Resend with the key, sender, recipient and the escaped verification link', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{"id":"x"}', { status: 200 }));
  }) as unknown as typeof fetch;
  const mail = makeResendGuardianMail('re_test', 'Studify <a@b.test>', fetchImpl);
  await mail({ guardianEmail: 'mae@example.test', verifyUrl: 'https://s.test/guardian/a"b&c' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.url, 'https://api.resend.com/emails');
  assertEquals((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer re_test');
  const body = JSON.parse(calls[0]!.init.body as string);
  assertEquals(body.from, 'Studify <a@b.test>');
  assertEquals(body.to, ['mae@example.test']);
  assertStringIncludes(body.html, 'href="https://s.test/guardian/a&quot;b&amp;c"');
  assertStringIncludes(body.text, 'https://s.test/guardian/a"b&c');
});

test('guardian mail: a non-2xx answer from Resend throws', async () => {
  const fetchImpl = (() => Promise.resolve(new Response('{}', { status: 422 }))) as unknown as typeof fetch;
  const mail = makeResendGuardianMail('re_test', 'Studify <a@b.test>', fetchImpl);
  let thrown: unknown = null;
  await mail({ guardianEmail: 'mae@example.test', verifyUrl: 'https://s.test/guardian/x' }).catch((e) => (thrown = e));
  assert(thrown instanceof Error && thrown.message.includes('422'));
});
