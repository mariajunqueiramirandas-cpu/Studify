import { test } from 'bun:test';
// Token verification (api §2.1, ADR 0011): a signed-in student's token is verified once and remembered for a
// minute, so a burst of calls from one session pays one check; tokens without a student are refused.
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertEquals } from './assert.ts';
import { ALICE, makeHarness, withUsers } from './fakes.ts';
import { authenticate } from '../src/shared/auth.ts';
import { AuthError } from '../src/shared/errors.ts';

const withToken = (jwt: string) => new Request('http://api.test/api/x', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } });

async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof AuthError;
  }
}

test('auth: a verified token is remembered, so repeated calls verify it once', async () => {
  const h = makeHarness();
  withUsers(h);
  const first = await authenticate(withToken(ALICE.jwt), h.deps.db);
  const second = await authenticate(withToken(ALICE.jwt), h.deps.db);
  assertEquals(first, { userId: ALICE.id, email: ALICE.email, jwt: ALICE.jwt });
  assertEquals(second, first);
  assertEquals(h.db.claimChecks, 1);
  // Another runtime (another service client) keeps its own memory.
  const other = makeHarness();
  withUsers(other);
  await authenticate(withToken(ALICE.jwt), other.deps.db);
  assertEquals(other.db.claimChecks, 1);
});

test('auth: unknown tokens, no token, and project keys without a student are refused', async () => {
  const h = makeHarness();
  withUsers(h);
  assertEquals(await refused(() => authenticate(withToken('jwt-nobody'), h.deps.db)), true);
  assertEquals(await refused(() => authenticate(new Request('http://api.test/api/x', { method: 'POST' }), h.deps.db)), true);
  // The anon key is a valid project JWT, but it carries no student.
  const anonKey = { auth: { getClaims: async () => ({ data: { claims: { role: 'anon', exp: Math.floor(Date.now() / 1000) + 3600 } }, error: null }) } } as unknown as SupabaseClient;
  assertEquals(await refused(() => authenticate(withToken('anon-key'), anonKey)), true);
  // A token is remembered only until it expires: past that it is checked again (and refused by Supabase Auth).
  let checks = 0;
  const expiring = {
    auth: {
      getClaims: async () => {
        checks += 1;
        return checks === 1
          ? { data: { claims: { sub: ALICE.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 1 } }, error: null }
          : { data: null, error: { message: 'expired' } };
      },
    },
  } as unknown as SupabaseClient;
  await authenticate(withToken('expiring'), expiring);
  assertEquals(await refused(() => authenticate(withToken('expiring'), expiring)), true);
  assertEquals(checks, 2);
});
