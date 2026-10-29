// JWT verification (api.md §2.1, security-privacy §3). Every user call goes through supabase.auth.getUser
// before any service-role query, and the authorization checks in access.ts use the returned user id only.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure } from '@studify/shared';
import { AuthError } from './errors.ts';

export interface AuthUser {
  userId: string;
  email: string | null;
  jwt: string;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function authenticate(req: Request, db: SupabaseClient): Promise<AuthUser> {
  const jwt = bearerToken(req);
  if (!jwt) throw new AuthError();
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new AuthError();
  // A suspended account (admin-user-control) cannot refresh its session; this stops the access token it still
  // holds as well, so a suspension takes effect at once instead of when the token expires.
  const bannedUntil = data.user.banned_until;
  if (bannedUntil && Date.parse(bannedUntil) > Date.now()) {
    throw new ApiFailure('banned', { message: 'Sua conta está suspensa. Fale com quem organiza o Studify.' });
  }
  return { userId: data.user.id, email: data.user.email ?? null, jwt };
}
