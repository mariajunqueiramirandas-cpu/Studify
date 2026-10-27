// JWT verification (api.md §2.1, security-privacy §3). Every user call goes through supabase.auth.getUser
// before any service-role query, and the authorization checks in access.ts use the returned user id only.
import type { SupabaseClient } from '@supabase/supabase-js';
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
  return { userId: data.user.id, email: data.user.email ?? null, jwt };
}
