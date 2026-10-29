// Environment for the API process. Read once at startup; a missing or malformed variable stops the
// process with the full list of problems, so a bad Dokploy environment fails on the first boot.
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_APK_URL } from './site.ts';

const Env = z.object({
  PG_POOL_MAX: z.coerce.number().int().min(4).max(50).default(12),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /** Supabase Auth (accounts only, ADR 0012): project URL, secret key for admin calls, publishable key. */
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Points the SDK at the mock Claude server (packages/ai/src/mock) in local runs and tests. */
  ANTHROPIC_BASE_URL: z.url().optional(),
  /** Studify's own Postgres (the `db` service of docker-compose.yml). Session connections: the API holds advisory locks and LISTENs. */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://'),
  /** Directory of the stored files, one folder per bucket (a Docker volume in production). */
  STORAGE_DIR: z.string().min(1).default('/data/storage'),
  /** HMAC key of signed file links. At least 32 characters; changing it invalidates links already handed out. */
  STORAGE_SIGNING_KEY: z.string().min(32, 'must be at least 32 characters'),
  /** Public base of the API that signed file links start with. Default: https://<BASE_URL>/api. */
  PUBLIC_API_URL: z.url().optional(),
  /** Public host without scheme. Unset: studify.vendua.com.br. Empty: custom-scheme links only. */
  BASE_URL: z.string().optional(),
  /** Directory with the built link site. Default: apps/site/dist in the repo (the image sets /app/site). */
  SITE_DIR: z.string().min(1).optional(),
  /** Directory with the built web dashboard (/painel). Default: apps/dashboard/dist in the repo (the image sets /app/dashboard). */
  DASHBOARD_DIR: z.string().min(1).optional(),
  /** Where /download redirects. Default: the newest GitHub Release's studify.apk (site.ts DEFAULT_APK_URL). */
  APK_URL: z.url().optional(),
  /** Resend key for the guardian mail (SP-03). Unset: no guardian mail is sent. Sign-in codes go through Supabase's SMTP. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Sender of the guardian mail; its domain must be verified in Resend. Default: shared-p2/mail.ts DEFAULT_MAIL_FROM. */
  MAIL_FROM: z.string().min(3).optional(),
});

export interface ApiConfig {
  port: number;
  databasePoolMax: number;
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string | undefined;
  databaseUrl: string;
  storageDir: string;
  storageSigningKey: string;
  /** Public base of the API (signed file links), without a trailing slash. */
  publicApiUrl: string;
  /** Raw BASE_URL: undefined means the default host, '' means custom-scheme links (see shared-p2/util.ts). */
  baseUrl: string | undefined;
  siteDir: string;
  dashboardDir: string;
  apkUrl: string;
  resendApiKey: string | undefined;
  mailFrom: string | undefined;
  /** TTS_PROVIDER, GOOGLE_TTS_API_KEY, TTS_VOICE_*, TTS_USD_PER_MILLION_CHARS (packages/speech ttsFromEnv). */
  ttsEnv: Record<string, string | undefined>;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Default site directory: apps/site/dist (`pnpm --filter @studify/site build`), relative to this file (apps/api/src). */
export const DEFAULT_SITE_DIR = path.resolve(import.meta.dir, '../../site/dist');

/** Default dashboard directory: apps/dashboard/dist (`pnpm --filter @studify/dashboard build`). */
export const DEFAULT_DASHBOARD_DIR = path.resolve(import.meta.dir, '../../dashboard/dist');

/** https://<BASE_URL>/api; the production host when BASE_URL is unset; localhost when it is empty (local runs). */
function defaultPublicApiUrl(baseUrl: string | undefined, port: number): string {
  if (baseUrl === undefined) return 'https://studify.vendua.com.br/api';
  const host = baseUrl.trim();
  return host === '' ? `http://localhost:${port}/api` : `https://${host}/api`;
}

/** Empty strings mean "unset", except BASE_URL where empty has a meaning (custom-scheme links). */
function withoutEmpty(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined || (value.trim() === '' && key !== 'BASE_URL') ? undefined : value.trim();
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = Env.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '?');
      const missing = issue.code === 'invalid_type' && issue.input === undefined;
      return missing ? `${key} is missing` : `${key}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const v = parsed.data;
  return {
    port: v.PORT,
    databasePoolMax: v.PG_POOL_MAX,
    supabaseUrl: v.SUPABASE_URL.replace(/\/+$/, ''),
    serviceRoleKey: v.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: v.SUPABASE_ANON_KEY,
    anthropicApiKey: v.ANTHROPIC_API_KEY,
    anthropicBaseUrl: v.ANTHROPIC_BASE_URL,
    databaseUrl: v.DATABASE_URL,
    storageDir: v.STORAGE_DIR,
    storageSigningKey: v.STORAGE_SIGNING_KEY,
    publicApiUrl: (v.PUBLIC_API_URL ?? defaultPublicApiUrl(env.BASE_URL, v.PORT)).replace(/\/+$/, ''),
    baseUrl: env.BASE_URL === undefined ? undefined : env.BASE_URL.trim(),
    siteDir: v.SITE_DIR ?? DEFAULT_SITE_DIR,
    dashboardDir: v.DASHBOARD_DIR ?? DEFAULT_DASHBOARD_DIR,
    apkUrl: v.APK_URL ?? DEFAULT_APK_URL,
    resendApiKey: v.RESEND_API_KEY,
    mailFrom: v.MAIL_FROM,
    ttsEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('TTS_') || key === 'GOOGLE_TTS_API_KEY')),
  };
}
