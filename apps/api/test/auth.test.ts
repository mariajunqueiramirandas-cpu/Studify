import { test } from 'bun:test';
// Token verification (api §2.1, ADR 0011): a signed-in student's token is verified once and remembered for a
// minute (never past its expiry), so a burst of calls from one session pays one check; a suspension forgets the
// account's tokens, so it is refused at once; unknown tokens are refused.
import { ApiFailure } from '@studify/shared';
import { assertEquals } from './assert.ts';
import { ALICE, makeHarness, withUsers } from './fakes.ts';
import { authenticate, forgetUser } from '../src/shared/auth.ts';
import { AuthError } from '../src/shared/errors.ts';

const withToken = (jwt: string) => new Request('http://api.test/api/x', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } });

async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof AuthError) return 'auth';
    if (err instanceof ApiFailure) return err.code;
    throw err;
  }
}

/** A JWT-shaped token whose payload expires at `exp` (seconds). */
const tokenExpiring = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

test('auth: a verified token is remembered, so repeated calls verify it once', async () => {
  const h = makeHarness();
  withUsers(h);
  const first = await authenticate(withToken(ALICE.jwt), h.deps.db);
  const second = await authenticate(withToken(ALICE.jwt), h.deps.db);
  assertEquals(first, { userId: ALICE.id, email: ALICE.email, jwt: ALICE.jwt });
  assertEquals(second, first);
  assertEquals(h.db.userChecks, 1);
  // Another runtime (another service client) keeps its own memory.
  const other = makeHarness();
  withUsers(other);
  await authenticate(withToken(ALICE.jwt), other.deps.db);
  assertEquals(other.db.userChecks, 1);
});

test('auth: unknown tokens and no token are refused; an expired token is checked again', async () => {
  const h = makeHarness();
  withUsers(h);
  assertEquals(await refused(() => authenticate(withToken('jwt-nobody'), h.deps.db)), 'auth');
  assertEquals(await refused(() => authenticate(new Request('http://api.test/api/x', { method: 'POST' }), h.deps.db)), 'auth');
  // A token is remembered only until it expires: past that, every call asks Supabase Auth again.
  const expired = tokenExpiring(Math.floor(Date.now() / 1000) - 1);
  h.db.users.set(expired, { id: ALICE.id, email: ALICE.email });
  const before = h.db.userChecks;
  await authenticate(withToken(expired), h.deps.db);
  await authenticate(withToken(expired), h.deps.db);
  assertEquals(h.db.userChecks - before, 2);
});

test('auth: a suspension takes effect at once, even for a remembered token', async () => {
  const h = makeHarness();
  withUsers(h);
  await authenticate(withToken(ALICE.jwt), h.deps.db);
  h.db.users.set(ALICE.jwt, { id: ALICE.id, email: ALICE.email, banned_until: '2099-01-01T00:00:00Z' });
  forgetUser(h.deps.db, ALICE.id);
  assertEquals(await refused(() => authenticate(withToken(ALICE.jwt), h.deps.db)), 'banned');
});
