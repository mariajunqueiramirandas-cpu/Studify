// The account calls the server code makes. Accounts stay on Supabase Auth (ADR 0012); the API attaches an
// implementation that calls it and keeps the local auth.users copy current (apps/api/src/shared/supabase-auth.ts).
// The shapes are supabase-js's, so the call sites did not change.

export interface AuthUserRecord {
  id: string;
  email?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
  [field: string]: unknown;
}

export interface AuthResult<T> {
  data: T;
  error: { message: string; status?: number; code?: string } | null;
}

export interface DbAuth {
  getUser(jwt: string): Promise<AuthResult<{ user: AuthUserRecord | null }>>;
  admin: {
    deleteUser(id: string): Promise<AuthResult<unknown>>;
    updateUserById(id: string, attributes: { ban_duration?: string; [field: string]: unknown }): Promise<AuthResult<{ user: AuthUserRecord | null }>>;
    signOut(jwt: string, scope?: 'global' | 'local' | 'others'): Promise<AuthResult<unknown>>;
  };
}
