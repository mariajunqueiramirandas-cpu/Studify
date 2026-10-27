// Production wiring for the Phase 2 functions: extends the base runtime with the Realtime broadcaster, the
// user-scoped RPC runner and the public base URL. Built once at startup next to the base runtime.
import type { ApiConfig } from '../config.ts';
import { buildProdRuntime, type ProdRuntime } from '../shared/prod.ts';
import type { P2Deps } from './deps.ts';
import { makeRestBroadcaster } from './realtime.ts';
import { publicBaseUrl } from './util.ts';

export interface P2Runtime extends ProdRuntime {
  deps: P2Deps;
}

export function buildP2Runtime(config: ApiConfig): P2Runtime {
  const base = buildProdRuntime(config);
  const deps: P2Deps = {
    ...base.deps,
    userRpc: async (jwt, fn, args) => {
      const res = await base.deps.asUser(jwt).rpc(fn, args);
      return { data: res.data, error: res.error };
    },
    broadcast: makeRestBroadcaster(config.supabaseUrl, config.serviceRoleKey),
    // BASE_URL unset → studify.vendua.com.br (D-05); set to empty → custom-scheme links.
    baseUrl: publicBaseUrl(config.baseUrl),
    randomInt: (maxExclusive: number) => {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0] ?? 0) % maxExclusive;
    },
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  };
  return { ...base, deps };
}
