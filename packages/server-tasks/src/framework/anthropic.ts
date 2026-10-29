// Builds the ClaudeDeps the job handlers pass to @studify/ai. The only place that imports the SDK
// in the worker. ANTHROPIC_BASE_URL is set in tests and local runs to point at the mock server.
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, BudgetStore, ClaudeDeps, UsageSink } from '@studify/ai';

export interface ClaudeOptions {
  apiKey: string;
  baseURL?: string | null;
  /** Per attempt. The worker allows 10 minutes for streamed calls (ai-pipeline §10.2). */
  timeoutMs: number;
}

export function createAnthropicClient(options: ClaudeOptions): AnthropicLike {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    timeout: options.timeoutMs,
    // @studify/ai applies its own retry policy per request (ClaudeDeps.maxRetries).
    maxRetries: 0,
  });
  return client as unknown as AnthropicLike;
}

export function createClaudeDeps(params: {
  client: AnthropicLike;
  budget: BudgetStore;
  usage: UsageSink;
  timeoutMs: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): ClaudeDeps {
  return {
    client: params.client,
    budget: params.budget,
    usage: params.usage,
    timeoutMs: params.timeoutMs,
    maxRetries: 2,
    ...(params.clock ? { clock: params.clock } : {}),
    ...(params.sleep ? { sleep: params.sleep } : {}),
  };
}
