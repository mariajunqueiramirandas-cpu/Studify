// Public configuration from EXPO_PUBLIC_* variables (mobile-app.md §18). Secrets never go here.
declare const process: { env: Record<string, string | undefined> };

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  environment: string;
}

let cached: SupabaseEnv | null = null;

/**
 * Reads the Supabase configuration. Throws a descriptive error when a variable is missing, so the
 * misconfiguration shows up in the first screen instead of as an opaque network failure.
 */
export function getEnv(): SupabaseEnv {
  if (cached) return cached;
  // Expo inlines these only when the access is written literally, so keep the exact expressions.
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const missing: string[] = [];
  if (!url) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !anonKey) {
    throw new Error(
      `Configuração ausente: ${missing.join(', ')}. Crie apps/mobile/.env.development com as variáveis públicas do Supabase (docs/engineering/mobile-app.md §18).`,
    );
  }
  cached = {
    url: url.replace(/\/+$/, ''),
    anonKey,
    environment: process.env.EXPO_PUBLIC_ENV ?? 'development',
  };
  return cached;
}

const DEFAULT_API_URL = 'https://studify.vendua.com.br/api';

/**
 * Base URL of the backend API (apps/api, Bun + Hono), without a trailing slash. Functions are called as
 * `${base}/<name>`. Defaults to the production host; set EXPO_PUBLIC_API_URL to point at a local server.
 */
export function getApiUrl(): string {
  // Expo inlines this only when the access is written literally, so keep the exact expression.
  const raw = process.env.EXPO_PUBLIC_API_URL;
  const value = raw && raw.trim() !== '' ? raw.trim() : DEFAULT_API_URL;
  return value.replace(/\/+$/, '');
}
