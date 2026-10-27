// Dependency seam. Handlers receive a `Deps` object; production wiring (prod.ts) builds the real
// clients, and tests build fakes. Nothing in a handler reads the environment or creates a client.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnthropicLike, BudgetStore, ClaudeDeps, UsageSink } from '@studify/ai';

/** Enqueues a pg-boss job (ai-pipeline, api §7). Resolves the job id, or null when a singleton already exists. */
export type Enqueue = (queue: string, data: Record<string, unknown>, options?: EnqueueOptions) => Promise<string | null>;

export interface EnqueueOptions {
  singletonKey?: string;
  /** With singletonKey: at most one job per key per window (plan.recompute debounce, api §7). */
  singletonSeconds?: number;
  startAfterSeconds?: number;
  retryLimit?: number;
}

export interface AiDeps {
  client: AnthropicLike;
  budget: BudgetStore;
  usage: UsageSink;
  /** Per attempt. Edge default 120 s. */
  timeoutMs?: number;
  /** SDK retries. Default 2. */
  maxRetries?: number;
}

export interface Deps {
  /** Service-role client. Only used after the caller is authorized explicitly (security §3). */
  db: SupabaseClient;
  /** Public URL and anon key, for calls that must run as the signed-in user (join_class_group). */
  supabaseUrl: string;
  anonKey: string;
  /** A client that acts as the student (their JWT), for RPCs that read auth.uid(). */
  asUser(jwt: string): SupabaseClient;
  /**
   * Checks a fresh e-mail sign-in code (re-authentication for account reset and deletion) on a single-use
   * client. Never call auth.verifyOtp on `db`: the client keeps the session it returns and every later query
   * of the process then runs as that student instead of the service role.
   */
  verifyEmailCode(email: string, code: string): Promise<boolean>;
  ai: AiDeps;
  enqueue: Enqueue;
  now(): Date;
  newId(): string;
  /** SSE heartbeat interval. 15 s in production; 0 in tests. */
  heartbeatMs: number;
  /** Minimum client versionCode accepted, when known. Production reads app_versions. */
  minClientVersion?: () => Promise<number | null>;
  /** Optional clock for the pure rate-limit stub. */
  rateLimit?: (userId: string, fn: string) => Promise<boolean>;
}

export function claudeDepsFor(deps: Deps): ClaudeDeps {
  return {
    client: deps.ai.client,
    budget: deps.ai.budget,
    usage: deps.ai.usage,
    timeoutMs: deps.ai.timeoutMs ?? 120_000,
    maxRetries: deps.ai.maxRetries ?? 2,
    clock: () => deps.now().getTime(),
  };
}
