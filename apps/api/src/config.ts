// Environment for the API process. Read once at startup; a missing or malformed variable stops the
// process with the full list of problems, so a bad Dokploy environment fails on the first boot.
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_APK_URL } from './site.ts';

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Points the SDK at the mock Claude server (packages/ai/src/mock) in local runs and tests. */
  ANTHROPIC_BASE_URL: z.url().optional(),
  /** Session-mode Postgres connection (Supavisor port 5432). pg-boss needs session mode (docs/engineering/deployment.md). */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://'),
  /** Public host without scheme. Unset: studify.vendua.com.br. Empty: custom-scheme links only. */
  BASE_URL: z.string().optional(),
  /** Schema pg-boss uses. The worker creates it; the API only sends. Must match the worker's PG_BOSS_SCHEMA. */
  PG_BOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase SQL identifier')
    .default('pgboss'),
  /** Directory with the built link site. Default: apps/site/dist in the repo (the image sets /app/site). */
  SITE_DIR: z.string().min(1).optional(),
  /** Where /download redirects. Default: the newest GitHub Release's studify.apk (site.ts DEFAULT_APK_URL). */
  APK_URL: z.url().optional(),
});

export interface ApiConfig {
  port: number;
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string | undefined;
  databaseUrl: string;
  /** Raw BASE_URL: undefined means the default host, '' means custom-scheme links (see shared-p2/util.ts). */
  baseUrl: string | undefined;
  pgBossSchema: string;
  siteDir: string;
  apkUrl: string;
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
    supabaseUrl: v.SUPABASE_URL.replace(/\/+$/, ''),
    serviceRoleKey: v.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: v.SUPABASE_ANON_KEY,
    anthropicApiKey: v.ANTHROPIC_API_KEY,
    anthropicBaseUrl: v.ANTHROPIC_BASE_URL,
    databaseUrl: v.DATABASE_URL,
    baseUrl: env.BASE_URL === undefined ? undefined : env.BASE_URL.trim(),
    pgBossSchema: v.PG_BOSS_SCHEMA,
    siteDir: v.SITE_DIR ?? DEFAULT_SITE_DIR,
    apkUrl: v.APK_URL ?? DEFAULT_APK_URL,
    ttsEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('TTS_') || key === 'GOOGLE_TTS_API_KEY')),
  };
}
