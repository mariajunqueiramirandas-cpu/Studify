// Settings for domain operations running inside the API process.
import { z } from 'zod';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Points the SDK at the mock Claude server in tests and local runs. */
  ANTHROPIC_BASE_URL: z.url().optional(),
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(50).default(6),
  TASK_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Per-attempt Claude timeout. Domain calls allow 10 min (ai-pipeline §10.2). */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  /** Standard Claude calls a content wave runs at once (S2 concepts, S4 content, transcription). */
  AI_WAVE_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(24),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TaskConfig {
  databaseUrl: string | null;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  expoAccessToken: string | null;
  pgPoolMax: number;
  logLevel: LogLevel;
  aiTimeoutMs: number;
  waveConcurrency: number;
}

/** Empty strings in the environment mean "unset". */
function cleaned(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === undefined || value.trim() === '' ? undefined : value.trim();
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): TaskConfig {
  const parsed = EnvSchema.safeParse(cleaned(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid worker configuration: ${problems}`);
  }
  const v = parsed.data;
  return {
    databaseUrl: v.DATABASE_URL ?? null,
    supabaseUrl: v.SUPABASE_URL ?? null,
    supabaseServiceRoleKey: v.SUPABASE_SERVICE_ROLE_KEY ?? null,
    anthropicApiKey: v.ANTHROPIC_API_KEY ?? null,
    anthropicBaseUrl: v.ANTHROPIC_BASE_URL ?? null,
    expoAccessToken: v.EXPO_ACCESS_TOKEN ?? null,
    pgPoolMax: v.PG_POOL_MAX,
    logLevel: v.TASK_LOG_LEVEL,
    aiTimeoutMs: v.AI_TIMEOUT_MS,
    waveConcurrency: v.AI_WAVE_CONCURRENCY,
  };
}

/** Throws a single message listing every missing variable the running worker needs. */
export function assertRuntimeConfig(config: TaskConfig): void {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    throw new Error(`missing environment variables: ${missing.join(', ')}`);
  }
}
