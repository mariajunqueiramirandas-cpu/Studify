// JWT verification (api.md §2.1, security-privacy §3). Every user call goes through supabase.auth.getUser
// before any service-role query, and the authorization checks in access.ts use the returned user id only.
// A verified token is remembered briefly (never past its expiry), so a burst of calls from one session pays one
// round trip to Supabase Auth (ADR 0011); a suspension forgets the account's tokens, so it still takes effect at once.
import type { Db } from '@studify/db';
import { ApiFailure } from '@studify/shared';
import { AuthError } from './errors.ts';

export interface AuthUser {
  userId: string;
  email: string | null;
  jwt: string;
}

/** How long a verified token is trusted without checking it again (never past its own expiry). */
const VERIFIED_MS = 60_000;
const VERIFIED_MAX = 5_000;
/** Per service client, so each runtime (and each test harness) keeps its own. */
const verifiedBy = new WeakMap<Db, Map<string, { user: AuthUser; until: number }>>();

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** The token's own expiry (ms), read from its payload once Supabase Auth has accepted it; null when unreadable. */
function expiryOf(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, db: Db): Promise<AuthUser> {
  const jwt = bearerToken(req);
  if (!jwt) throw new AuthError();
  const now = Date.now();
  let verified = verifiedBy.get(db);
  if (!verified) verifiedBy.set(db, (verified = new Map()));
  const hit = verified.get(jwt);
  if (hit && hit.until > now) return hit.user;
  if (hit) verified.delete(jwt);

  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new AuthError();
  // A suspended account (admin-user-control) cannot refresh its session; this stops the access token it still
  // holds as well, so a suspension takes effect at once instead of when the token expires.
  const bannedUntil = data.user.banned_until;
  if (bannedUntil && Date.parse(bannedUntil) > now) {
    throw new ApiFailure('banned', { message: 'Sua conta está suspensa. Fale com quem organiza o Studify.' });
  }
  const user: AuthUser = { userId: data.user.id, email: data.user.email ?? null, jwt };
  if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
  verified.set(jwt, { user, until: Math.min(now + VERIFIED_MS, expiryOf(jwt) ?? now + VERIFIED_MS) });
  return user;
}

/** Forgets the remembered tokens of an account (a suspension), so its next call is checked by Supabase Auth again. */
export function forgetUser(db: Db, userId: string): void {
  const verified = verifiedBy.get(db);
  if (!verified) return;
  for (const [jwt, entry] of verified) if (entry.user.userId === userId) verified.delete(jwt);
}
