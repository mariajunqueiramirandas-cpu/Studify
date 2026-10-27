// Phase 2 dependency seam. Extends the shared Deps (supabase/functions/_shared/deps.ts) with what the
// Turma, duel and battle functions need beyond the base pipeline. Tests build fakes for every member.
import type { TtsProvider } from '@studify/speech';
import type { Deps } from '../shared/deps.ts';

/** Runs an RPC as the signed-in user (anon key + user JWT), so auth.uid() is the caller (join_class_group). */
export type UserRpc = (
  jwt: string,
  fn: string,
  args: Record<string, unknown>,
) => Promise<
  {
    data: unknown;
    error: { message?: string | null; hint?: string | null; code?: string | null; details?: string | null } | null;
  }
>;

export interface BroadcastMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  /** Private channels need Realtime Authorization (api §8.2). Every Studify broadcast is private. */
  private: true;
}

/** Sends broadcast messages through the Realtime REST endpoint (service key). Never throws to the caller. */
export type Broadcaster = (messages: BroadcastMessage[]) => Promise<void>;

/** Guardian verification mail (SP-03), sent through Resend (mail.ts). Undefined when RESEND_API_KEY is unset. */
export type GuardianMail = (args: { guardianEmail: string; verifyUrl: string }) => Promise<void>;

export interface P2Deps extends Deps {
  userRpc: UserRpc;
  broadcast: Broadcaster;
  /** Public host without scheme (e.g. "studify.app"), or null: links fall back to studify:// routes. */
  baseUrl: string | null;
  /** Uniform integer in [0, maxExclusive). Injected for tests (PIN generation). */
  randomInt(maxExclusive: number): number;
  /** Cryptographically random bytes (share tokens, guardian tokens). */
  randomBytes(n: number): Uint8Array;
  guardianMail?: GuardianMail;
  /** Cloud TTS for ✋ answers (INT-01.8). Null or unset: the app reads them with on-device TTS (INT-01.11). */
  tts?: TtsProvider | null;
  /** Signed download URL of a stored object (`bucket/path`), or null when it cannot be signed. */
  signedUrl?: (path: string, ttlSeconds: number) => Promise<string | null>;
  /** Uploads bytes with a content type (audio answers). */
  uploadObject?: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
}
