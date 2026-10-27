// Supabase session storage (mobile-app.md §12): a random AES-256 key lives in expo-secure-store
// (Android Keystore); the encrypted session JSON lives in MMKV. SecureStore values are size-limited,
// so only the key goes there. Each value gets its own random IV (never a fixed counter).
import aes from 'aes-js';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { getKv } from '../lib/kv';

const KEY_NAME = 'studify.session.key.v1';
const PREFIX = 'supabase.session.v1.';
const IV_BYTES = 16;

let cachedKey: Uint8Array | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function encryptionKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  let stored = await SecureStore.getItemAsync(KEY_NAME);
  if (!stored) {
    stored = toBase64(getRandomBytes(32));
    await SecureStore.setItemAsync(KEY_NAME, stored, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  }
  cachedKey = fromBase64(stored);
  return cachedKey;
}

async function encrypt(plain: string): Promise<string> {
  const key = await encryptionKey();
  const iv = getRandomBytes(IV_BYTES);
  const ctr = new aes.ModeOfOperation.ctr(key, new aes.Counter(iv));
  const cipher = ctr.encrypt(new TextEncoder().encode(plain));
  return `${toBase64(iv)}.${toBase64(cipher)}`;
}

async function decrypt(payload: string): Promise<string> {
  const key = await encryptionKey();
  const [ivPart, dataPart] = payload.split('.');
  if (!ivPart || !dataPart) throw new Error('malformed session payload');
  const ctr = new aes.ModeOfOperation.ctr(key, new aes.Counter(fromBase64(ivPart)));
  const plain = ctr.decrypt(fromBase64(dataPart));
  return new TextDecoder().decode(plain);
}

/**
 * Storage adapter for supabase-js `auth.storage`. A session that cannot be decrypted (key lost,
 * device restored) reads as signed out instead of throwing.
 */
export const LargeSecureStore = {
  async getItem(key: string): Promise<string | null> {
    const payload = getKv().getString(PREFIX + key);
    if (payload === undefined) return null;
    try {
      return await decrypt(payload);
    } catch {
      getKv().remove(PREFIX + key);
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    getKv().set(PREFIX + key, await encrypt(value));
  },
  async removeItem(key: string): Promise<void> {
    getKv().remove(PREFIX + key);
  },
};
