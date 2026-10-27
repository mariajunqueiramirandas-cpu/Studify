// Production wiring. Only the function entry points (index.ts) call this; handlers never do.
// Reads the environment once and memoizes the clients for the isolate's lifetime.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import postgres from 'postgres';
import type { AnthropicLike } from '@studify/ai';
import { uuidV7 } from '@studify/shared';
import { makeBudgetStore, makeUsageSink } from './budget.ts';
import type { Deps } from './deps.ts';
import { makePgBossEnqueue } from './enqueue.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

let cached: Deps | undefined;
let minVersionCache: { value: number | null; at: number } | undefined;

/** Lowest client versionCode allowed (app_versions.blocks_older), cached for 60 s. */
async function minClientVersionFrom(db: SupabaseClient): Promise<number | null> {
  if (minVersionCache && Date.now() - minVersionCache.at < 60_000) return minVersionCache.value;
  const { data } = await db
    .from('app_versions')
    .select('version_code')
    .eq('blocks_older', true)
    .order('version_code', { ascending: false })
    .limit(1)
    .maybeSingle();
  const value = data ? Number(data.version_code) : null;
  minVersionCache = { value, at: Date.now() };
  return value;
}

export function prodDeps(): Deps {
  if (cached) return cached;
  const supabaseUrl = required('SUPABASE_URL');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const client = new Anthropic({
    apiKey: required('ANTHROPIC_API_KEY'),
    baseURL: Deno.env.get('ANTHROPIC_BASE_URL') || undefined,
    maxRetries: 0,
  }) as unknown as AnthropicLike;
  const sql = postgres(required('DATABASE_URL'), { prepare: false, max: 1, idle_timeout: 5 });
  cached = {
    db,
    supabaseUrl,
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    asUser: (jwt: string) =>
      createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ai: { client, budget: makeBudgetStore(db), usage: makeUsageSink(db), timeoutMs: 120_000, maxRetries: 2 },
    enqueue: makePgBossEnqueue(sql, uuidV7),
    now: () => new Date(),
    newId: () => uuidV7(),
    heartbeatMs: 15_000,
    minClientVersion: () => minClientVersionFrom(db),
    // Rate-limit stub (api §2.5: 10 AI requests per minute per user). Not enforced yet; the budget
    // gate still caps spend. Replace with a counter table when the limit is turned on.
    rateLimit: async () => true,
  };
  return cached;
}
