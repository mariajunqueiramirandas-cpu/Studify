import { supabase } from '../../api/supabase';

/** Throws on Supabase errors so TanStack Query sees them; returns typed rows. */
export async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return (data as T[] | null) ?? [];
}

export async function row<T>(q: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return (data as T | null) ?? null;
}

/** RPC parameters are declared `p_<name>` in the migrations; callers pass api.md names. */
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const params = Object.fromEntries(Object.entries(args).map(([k, v]) => [k.startsWith('p_') ? k : `p_${k}`, v]));
  const { data, error } = await supabase.rpc(fn, params);
  if (error) {
    // RPCs raise ApiError codes in the message/hint (api.md §2.2).
    const code = (error.hint || error.message || '').match(/[a-z_]{4,}/)?.[0] ?? 'internal_error';
    throw Object.assign(new Error(error.message), { code });
  }
  return data as T;
}

export function errorCode(e: unknown): string {
  return (e as { code?: string } | null)?.code ?? '';
}
