// Device/server clock alignment for LWW timestamps and "reviewed in the future" checks.
// The offset is learned from every server response (sync-push `server_time`, HTTP `date`).
import { CLOCK_TOLERANCE_MS } from './constants';

let offsetMs = 0; // serverNow - deviceNow

/** Records the server's current time (ISO string or epoch ms) observed at device time `deviceNowMs`. */
export function observeServerTime(server: string | number | Date | null | undefined, deviceNowMs: number = Date.now()): void {
  if (server === null || server === undefined) return;
  const ms = typeof server === 'number' ? server : parseInstantMs(server instanceof Date ? server.toISOString() : server);
  if (Number.isFinite(ms)) offsetMs = ms - deviceNowMs;
}

export function serverNowMs(deviceNowMs: number = Date.now()): number {
  return deviceNowMs + offsetMs;
}

/** Clamps a client timestamp to server time ± tolerance (neutralizes a wrong device clock). */
export function clampClientTime(clientMs: number, serverNowMsValue: number, tolerance = CLOCK_TOLERANCE_MS): number {
  return Math.min(Math.max(clientMs, serverNowMsValue - tolerance), serverNowMsValue + tolerance);
}

/** The `updated_at` to attach to an LWW edit made now on this device. */
export function lwwUpdatedAtMs(deviceNowMs: number = Date.now()): number {
  return clampClientTime(deviceNowMs, serverNowMs(deviceNowMs));
}

/** Test helper. */
export function resetClockForTests(): void {
  offsetMs = 0;
}

/**
 * Parses an instant from PostgREST / JSON. Postgres returns microseconds and `+00:00` offsets,
 * which some JS engines (Hermes) reject, so fractional seconds are cut to milliseconds first.
 */
export function parseInstantMs(value: string): number {
  const normalized = value.replace(/(\.\d{3})\d+/, '$1');
  return Date.parse(normalized);
}
