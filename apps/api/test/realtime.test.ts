import { test } from 'bun:test';
// Realtime REST broadcast: which headers carry the Supabase key (publishable/secret vs legacy JWT keys).
import { assert, assertEquals } from './assert.ts';
import { makeRestBroadcaster, apiKeyHeaders } from '../src/shared-p2/realtime.ts';
import type { BroadcastMessage } from '../src/shared-p2/deps.ts';

const MESSAGE: BroadcastMessage = { topic: 'user:abc', event: 'refresh', payload: {}, private: true };

function captureFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('secret key goes only in apikey, never as Bearer', async () => {
  const key = 'sb_secret_example_value';
  const { calls, fetchImpl } = captureFetch();
  await makeRestBroadcaster('https://proj.supabase.co/', key, fetchImpl)([MESSAGE]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.url, 'https://proj.supabase.co/realtime/v1/api/broadcast');
  assertEquals(calls[0]!.headers.apikey, key);
  assert(calls[0]!.headers.Authorization === undefined, 'no Authorization header for a secret key');
});

test('publishable key goes only in apikey', () => {
  assertEquals(apiKeyHeaders('sb_publishable_example'), { apikey: 'sb_publishable_example' });
});

test('legacy JWT service key keeps the Bearer copy during the transition', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.e30.sig';
  assertEquals(apiKeyHeaders(jwt), { apikey: jwt, Authorization: `Bearer ${jwt}` });
});

test('an empty batch makes no request', async () => {
  const { calls, fetchImpl } = captureFetch();
  await makeRestBroadcaster('https://proj.supabase.co', 'sb_secret_x', fetchImpl)([]);
  assertEquals(calls.length, 0);
});
