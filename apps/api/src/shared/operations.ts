// Per-runtime live streams. The DB owns durable idempotency; this map owns live fan-out only.
import type { Deps } from './deps.ts';
import type { IdempotencyHandle } from './idempotency.ts';
import type { SseOperation } from './sse.ts';

export interface LiveOperation {
  hash: string;
  operation: SseOperation;
  handles: IdempotencyHandle[];
}
interface Operations {
  active: Map<string, LiveOperation>;
  locks: Map<string, Promise<void>>;
}
const runtimes = new WeakMap<Deps, Operations>();
export function operationsFor(deps: Deps): Operations {
  let state = runtimes.get(deps);
  if (!state) { state = { active: new Map(), locks: new Map() }; runtimes.set(deps, state); }
  return state;
}

/** Serialize admission, including DB awaits, so simultaneous double taps cannot start two paid calls. */
export async function admit<T>(deps: Deps, scope: string, run: () => Promise<T>): Promise<T> {
  const { locks } = operationsFor(deps);
  const previous = locks.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  locks.set(scope, next);
  await previous;
  try { return await run(); }
  finally { release(); if (locks.get(scope) === next) locks.delete(scope); }
}

export async function drainOperations(deps: Deps): Promise<void> {
  const operations = new Set([...operationsFor(deps).active.values()].map((entry) => entry.operation));
  await Promise.allSettled([...operations].map((operation) => operation.done));
}
