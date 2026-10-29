// Calls to the Studify API (POST /api/<name>, api.md §2). Mutating calls carry an Idempotency-Key (UUID v7), so a
// resent request is answered once. Errors arrive as { error: { code, message } } with a message safe to show.
import { supabase } from './supabase.ts';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** RFC 9562 UUID v7: 48-bit millisecond time, version 7, variant 10, random rest. */
export function uuidv7(now: number = Date.now(), random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  const b = Uint8Array.from(random);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Called when the API refuses the session (expired, revoked or suspended), so the app can sign out. */
let onUnauthorized: ((error: ApiError) => void) | null = null;
export function setUnauthorizedHandler(handler: (error: ApiError) => void): void {
  onUnauthorized = handler;
}

export const OFFLINE_MESSAGE = 'Sem conexão com o Studify. Confira sua internet e tente de novo.';

export async function callApi<T>(name: string, body: unknown = {}, options: { mutating?: boolean } = {}): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    const error = new ApiError('forbidden', 'Entre na sua conta pra continuar.', 401);
    onUnauthorized?.(error);
    throw error;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (options.mutating) headers['idempotency-key'] = uuidv7();
  let res: Response;
  try {
    res = await fetch(`/api/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', OFFLINE_MESSAGE, 0);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page, not the API: handled below as a generic failure.
  }
  if (!res.ok) {
    const envelope = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    const error = new ApiError(envelope?.code ?? 'internal_error', envelope?.message ?? 'Algo deu errado. Tenta de novo?', res.status);
    if (res.status === 401 || error.code === 'banned') onUnauthorized?.(error);
    throw error;
  }
  return parsed as T;
}

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Algo deu errado. Tenta de novo?';
}
