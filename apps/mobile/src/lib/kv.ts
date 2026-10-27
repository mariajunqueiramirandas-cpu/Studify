// Small key-value storage (MMKV v4). Holds settings, feature-flag cache, device id, persisted
// stores and the query cache. Never holds secrets: the auth session is encrypted separately (api/secure-session-storage.ts).
import { createMMKV, type MMKV } from 'react-native-mmkv';

let instance: MMKV | null = null;

export function getKv(): MMKV {
  if (!instance) instance = createMMKV({ id: 'studify-kv' });
  return instance;
}

/** Storage adapter shaped for zustand's `createJSONStorage`. Writes are synchronous and never throw. */
export const kvStateStorage = {
  getItem: (name: string): string | null => {
    try {
      return getKv().getString(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      getKv().set(name, value);
    } catch {
      // Storage unavailable (e.g. full): the store keeps working in memory.
    }
  },
  removeItem: (name: string): void => {
    try {
      getKv().remove(name);
    } catch {
      // ignore
    }
  },
};
