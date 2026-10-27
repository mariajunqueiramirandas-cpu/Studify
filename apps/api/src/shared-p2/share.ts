// Quiz share snapshot and token rules (SOC-09). The snapshot is what outsiders may see: question text and
// choices only. Never answer keys, correctness flags, explanations, rationales or page references (D-32).
import { ApiFailure } from '@studify/shared';

export const SHARE_TOKEN_BYTES = 16; // base64url → 22 characters
export const SHARE_TTL_DAYS = 30;
export const SHARE_DAILY_LIMIT = 50;
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export interface ShareSnapshot {
  version: 1;
  title: string | null;
  subject_name: string | null;
  questions: Record<string, unknown>[];
}

/** Rejects snapshots that carry keys that must never leave the server (defense in depth for SOC-09.2). */
const FORBIDDEN_KEYS = [
  'correct',
  'correct_response',
  'answer',
  'explanation',
  'rationale',
  'source_pages',
  'justification',
];

export function assertSnapshotSafe(value: unknown, path = 'snapshot'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSnapshotSafe(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(key)) throw new Error(`share snapshot leaks ${key} at ${path}`);
      assertSnapshotSafe(child, `${path}.${key}`);
    }
  }
}

export function requireToken(token: string): string {
  if (!SHARE_TOKEN_RE.test(token)) throw new ApiFailure('not_found');
  return token;
}
