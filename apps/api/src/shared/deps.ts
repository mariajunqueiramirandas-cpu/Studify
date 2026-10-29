// Dependency seam. Handlers receive a `Deps` object; production wiring (prod.ts) builds the real
// clients, and tests build fakes. Nothing in a handler reads the environment or creates a client.
import type { Db } from '@studify/db';
import type { AuthUser } from './auth.ts';
import type { AnthropicLike, BudgetStore, ClaudeDeps, UsageSink } from '@studify/ai';

/** Invokes a domain operation directly and awaits it; a future start time registers a calendar trigger. */
export type Execute = (queue: string, data: Record<string, unknown>, options?: ExecuteOptions) => Promise<string | null>;

export interface ExecuteOptions {
  signal?: AbortSignal;
  onProgress?: (id: string, patch: Record<string, unknown>) => void;
  singletonKey?: string;
  startAfterSeconds?: number;
}

/**
 * Starts an operation without holding the caller (ADR 0011): it is registered as a calendar trigger due now, so it
 * starts within about a second, survives an API restart that happens before it starts, and its duration never adds
 * to the request. For side effects the response does not wait for: AI grading the app polls for, flag triage,
 * pushes, topic regeneration. `execute` without a start time still runs the operation and awaits it.
 */
export function inBackground(deps: Deps, name: string, data: Record<string, unknown>, singletonKey?: string): Promise<string | null> {
  return deps.execute(name, data, { ...(singletonKey ? { singletonKey } : {}), startAfterSeconds: 0 });
}

export interface AiDeps {
  client: AnthropicLike;
  budget: BudgetStore;
  usage: UsageSink;
  /** Per attempt. Edge default 120 s. */
  timeoutMs?: number;
  /** SDK retries. Default 1; retries happen only inside a single model call. */
  maxRetries?: number;
}

export interface Deps {
  signal?: AbortSignal;
  /** Service client on Studify's Postgres (bypasses RLS). Only used after the caller is authorized explicitly (security §3). */
  db: Db;
  /** Supabase Auth's public URL and publishable key (accounts stay on Supabase Auth, ADR 0012). */
  supabaseUrl: string;
  anonKey: string;
  /** A client that acts as the verified student (role authenticated, their claims), so RLS and auth.uid() apply. */
  asUser(user: AuthUser): Db;
  /**
   * Checks a fresh e-mail sign-in code (re-authentication for account reset and deletion) on a single-use
   * client. Never call auth.verifyOtp on `db`: the client keeps the session it returns and every later query
   * of the process then runs as that student instead of the service role.
   */
  verifyEmailCode(email: string, code: string): Promise<boolean>;
  ai: AiDeps;
  execute: Execute;
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
    signal: deps.signal,
    budget: deps.ai.budget,
    usage: deps.ai.usage,
    timeoutMs: deps.ai.timeoutMs ?? 120_000,
    maxRetries: deps.ai.maxRetries ?? 1,
    clock: () => deps.now().getTime(),
  };
}
