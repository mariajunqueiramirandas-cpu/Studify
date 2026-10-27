// UUID v7 (RFC 9562) with no dependencies. Used for every client-generated row id:
// outbox items, review_logs, quiz_attempts, attempt_answers, study_sessions, xp_events,
// feed_impressions, and idempotency keys (data-model §1.1, api §2.4, ADR 0007).
// Server ids from auth.users (profiles.id) are random v4 and are NOT v7; use isUuid for them.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for any canonical UUID string (any version, including the nil UUID). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** True only for canonical UUID v7 strings. */
export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

// PLT-07 / ADR 0007: ids must sort by creation time so the server replays logs deterministically.
// The 12-bit `rand_a` field is a per-process counter (RFC 9562 §6.2, method 1), so ids created in
// the same millisecond still increase strictly. This only holds within one process; across devices
// the ordering is by the millisecond prefix.
let lastMs = -1;
let counter = 0;

// Web Crypto is global on Hermes (with expo-crypto), Deno and Node 22. Typed locally so the package
// does not depend on the DOM lib.
interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: RandomSource }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('uuidV7: crypto.getRandomValues is not available in this runtime');
  }
  return c.getRandomValues(new Uint8Array(n));
}

const HEX = '0123456789abcdef';

/**
 * Generates a UUID v7 string (lowercase, canonical 8-4-4-4-12 form).
 * `nowMs` is injectable for tests; production callers use the default.
 */
export function uuidV7(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('uuidV7: nowMs must be a non-negative safe integer');
  }
  const rand = randomBytes(10);
  let ms = nowMs;

  if (ms > lastMs) {
    lastMs = ms;
    // Start each new millisecond at a random value with the top bit clear, leaving headroom.
    counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
  } else {
    // Same millisecond (or the clock went backwards): stay on lastMs and increment the counter.
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted inside one millisecond: borrow the next millisecond instead of wrapping.
      lastMs += 1;
      ms = lastMs;
      counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
    }
  }

  const bytes = new Uint8Array(16);
  // 48-bit unix_ts_ms, big-endian.
  let t = ms;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7
  bytes[7] = counter & 0xff;
  // Remaining 62 bits are random, variant bits 10xxxxxx.
  const tail = randomBytes(8);
  for (let i = 0; i < 8; i += 1) bytes[8 + i] = tail[i] ?? 0;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const b = bytes[i] ?? 0;
    out += (HEX[b >> 4] ?? '0') + (HEX[b & 0x0f] ?? '0');
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/** Decodes the unix millisecond timestamp of a UUID v7, or null when the value is not a v7 UUID. */
export function uuidV7Time(id: string): number | null {
  if (!isUuidV7(id)) return null;
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}
