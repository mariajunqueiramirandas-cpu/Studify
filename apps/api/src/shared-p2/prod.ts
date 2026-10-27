// Production wiring for the Phase 2 functions: extends the base runtime with the Realtime broadcaster, the
// user-scoped RPC runner and the public base URL. Built once at startup next to the base runtime.
import { ttsFromEnv } from '@studify/speech';
import type { ApiConfig } from '../config.ts';
import { buildProdRuntime, type ProdRuntime } from '../shared/prod.ts';
import type { P2Deps } from './deps.ts';
import { DEFAULT_MAIL_FROM, makeResendGuardianMail } from './mail.ts';
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
    // SP-03 guardian mail. No RESEND_API_KEY: the link is still created, but no mail goes out.
    guardianMail: config.resendApiKey ? makeResendGuardianMail(config.resendApiKey, config.mailFrom ?? DEFAULT_MAIL_FROM) : undefined,
    // INT-01.8 ✋ audio. Null (TTS_PROVIDER=device or no key): the app reads answers with on-device TTS.
    tts: ttsFromEnv(config.ttsEnv),
    signedUrl: async (path: string, ttlSeconds: number) => {
      const slash = path.indexOf('/');
      const { data, error } = await base.deps.db.storage.from(path.slice(0, slash)).createSignedUrl(path.slice(slash + 1), ttlSeconds);
      return error || !data ? null : data.signedUrl;
    },
    uploadObject: async (path: string, bytes: Uint8Array, contentType: string) => {
      const slash = path.indexOf('/');
      const { error } = await base.deps.db.storage.from(path.slice(0, slash)).upload(path.slice(slash + 1), bytes, { contentType, upsert: true });
      if (error) throw error;
    },
  };
  return { ...base, deps };
}
