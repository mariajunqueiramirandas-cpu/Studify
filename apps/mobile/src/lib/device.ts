// Stable per-install id, sent as `x-device-id` and `device_id` (one per install, survives updates).
import { uuidv7 } from 'uuidv7';
import { getKv } from './kv';

const KEY = 'device.id';
let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;
  try {
    const stored = getKv().getString(KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
    const id = uuidv7();
    getKv().set(KEY, id);
    cached = id;
    return id;
  } catch {
    // Storage unavailable: a session-scoped id is still correct for idempotency purposes.
    cached = cached ?? uuidv7();
    return cached;
  }
}
