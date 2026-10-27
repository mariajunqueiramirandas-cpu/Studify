// Production wiring for the Phase 2 functions. Extends the shared prodDeps() (memoized per isolate) with the
// Realtime broadcaster, the user-scoped RPC runner and the public base URL. Only index.ts entry points call it.
import { prodDeps } from '../_shared/prod.ts';
import type { P2Deps } from './deps.ts';
import { makeRestBroadcaster } from './realtime.ts';
import { normalizeBaseUrl } from './util.ts';

let cached: P2Deps | undefined;

export function prodP2Deps(): P2Deps {
  if (cached) return cached;
  const base = prodDeps();
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  cached = {
    ...base,
    userRpc: async (jwt, fn, args) => {
      const res = await base.asUser(jwt).rpc(fn, args);
      return { data: res.data, error: res.error };
    },
    broadcast: makeRestBroadcaster(base.supabaseUrl, serviceKey),
    baseUrl: normalizeBaseUrl(Deno.env.get('BASE_URL')),
    randomInt: (maxExclusive: number) => {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0] ?? 0) % maxExclusive;
    },
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  };
  return cached;
}
