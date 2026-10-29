// JWT verification (api.md §2.1, security-privacy §3). Every user call verifies the caller's access token before any
// service-role query, and the authorization checks in access.ts use the verified user id only. The signature is
// checked locally against the project's signing keys when it signs with asymmetric keys (auth.getClaims, JWKS cached
// by supabase-js); otherwise getClaims asks Supabase Auth, as getUser did. A verified token is remembered briefly,
// so a burst of calls from one session pays one verification (ADR 0011).
import type { SupabaseClient } from '@supabase/supabase-js';
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
const verifiedBy = new WeakMap<SupabaseClient, Map<string, { user: AuthUser; until: number }>>();

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticate(req: Request, db: SupabaseClient): Promise<AuthUser> {
  const jwt = bearerToken(req);
  if (!jwt) throw new AuthError();
  const now = Date.now();
  let verified = verifiedBy.get(db);
  if (!verified) verifiedBy.set(db, (verified = new Map()));
  const hit = verified.get(jwt);
  if (hit && hit.until > now) return hit.user;
  if (hit) verified.delete(jwt);

  const { data, error } = await db.auth.getClaims(jwt);
  const claims = data?.claims;
  // Only a signed-in student's token: the project's anon and service keys are valid JWTs too, without a user.
  if (error || !claims || typeof claims.sub !== 'string' || !claims.sub || claims.role !== 'authenticated') throw new AuthError();
  const user: AuthUser = { userId: claims.sub, email: typeof claims.email === 'string' && claims.email ? claims.email : null, jwt };
  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : now;
  if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value!);
  verified.set(jwt, { user, until: Math.min(now + VERIFIED_MS, expiresAt) });
  return user;
}
