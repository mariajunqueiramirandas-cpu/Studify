// Supabase Auth only (@supabase/auth-js, the auth client inside supabase-js): the e-mail code sign-in and the
// session. Every read and write goes through the API (/api/account-*, /api/admin-*), which checks the session and
// the admin role itself, so the database, storage and realtime clients are not shipped.
import { GoTrueClient } from '@supabase/auth-js';
import type { RuntimeConfig } from './config.ts';

let client: { auth: GoTrueClient } | null = null;

export function initSupabase(config: RuntimeConfig): { auth: GoTrueClient } {
  client ??= {
    auth: new GoTrueClient({
      url: `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1`,
      headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` },
      storageKey: 'studify-painel-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    }),
  };
  return client;
}

export function supabase(): { auth: GoTrueClient } {
  if (!client) throw new Error('supabase is not initialized');
  return client;
}

/**
 * Sends the 6-digit sign-in code. Never creates an account: sign-up needs an invite and happens in the app. An
 * unknown address answers like a known one, so the page does not reveal who has an account.
 */
export async function sendCode(email: string): Promise<'sent' | 'rate_limited'> {
  const { error } = await supabase().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error?.status === 429) return 'rate_limited';
  return 'sent';
}

export async function verifyCode(email: string, token: string): Promise<boolean> {
  const { error } = await supabase().auth.verifyOtp({ email, token, type: 'email' });
  return !error;
}
