// Small pure helpers shared by the Phase 2 functions.
import { localDateOf } from '@studify/shared';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding. 16 bytes → 22 characters (SOC-09 share token). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
    if (b !== undefined) out += B64URL[(n >> 6) & 63];
    if (c !== undefined) out += B64URL[n & 63];
  }
  return out;
}

export function randomToken(randomBytes: (n: number) => Uint8Array, bytes = 16): string {
  return base64url(randomBytes(bytes));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const SAO_PAULO = 'America/Sao_Paulo';

/** Start of the student's local day (America/Sao_Paulo has no DST since 2019) as an ISO instant. */
export function startOfLocalDayIso(now: Date): string {
  return `${localDateOf(now, SAO_PAULO)}T00:00:00-03:00`;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Seconds from `now` until `at`, never negative (the API runtime startAfter). */
export function secondsUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

/** Public host with the scheme removed and no trailing slash. Null when the env var is empty. */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host.length > 0 ? host : null;
}

/** Production public host for HTTPS links (D-05, owner decision 2026-10-27). */
export const DEFAULT_PUBLIC_HOST = 'studify.vendua.com.br';

/**
 * BASE_URL resolution. Unset (undefined) uses DEFAULT_PUBLIC_HOST. An explicitly empty BASE_URL
 * returns null, which keeps the custom-scheme (studify://) fallback in shareUrl and guardian links.
 */
export function publicBaseUrl(raw: string | null | undefined): string | null {
  return normalizeBaseUrl(raw ?? DEFAULT_PUBLIC_HOST);
}

/** Quiz share link (SOC-09.4): https App Link when BASE_URL is set, else the custom-scheme route. */
export function shareUrl(baseUrl: string | null, token: string): string {
  return baseUrl ? `https://${baseUrl}/q/${token}` : `studify://quiz/shared/${token}`;
}

/** Uniform string of `width` digits (PIN). */
export function padDigits(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
