// join-class — SOC-01.2, SOC-01.14. Wraps RPC join_class_group, running as the caller so auth.uid() is the joiner.
// After an invalid, expired or used-up code the failure is recorded with the service role (record_join_failure),
// so the 5-per-hour limit trips. The RPC error codes are passed through unchanged.
import { z } from 'zod';
import { ApiFailure, type ErrorCode } from '@studify/shared';
import { defineP2 } from '../_shared_p2/http.ts';
import { failureFromPg } from '../_shared/errors.ts';

export const JoinClassInput = z.object({ code: z.string().min(8).max(12) });
export type JoinClassInput = z.infer<typeof JoinClassInput>;

/** Codes that count as failures for the rate limit (api §5, SOC-01.14). */
const COUNTED_FAILURES: readonly ErrorCode[] = ['invite_invalid', 'invite_expired', 'invite_used_up'];

/** Normalizes the grouped display form ("ABCD-EFGH") and checks the 8-character safe alphabet (SOC-01.2). */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null;
}

export const handler = defineP2<JoinClassInput>({
  name: 'join-class',
  mutating: true,
  input: JoinClassInput,
  run: async (ctx) => {
    const { p2, input: i } = ctx;
    const me = ctx.user.userId;
    const code = normalizeCode(i.code);

    const failCounted = async (code: ErrorCode): Promise<never> => {
      const recorded = await p2.db.rpc('record_join_failure', { p_user_id: me });
      if (recorded.error) console.error('record_join_failure failed', recorded.error.message);
      throw new ApiFailure(code);
    };
    if (!code) return failCounted('invite_invalid');

    const res = await p2.userRpc(ctx.user.jwt, 'join_class_group', { p_code: code });
    if (res.error) {
      const failure = failureFromPg(res.error);
      if (COUNTED_FAILURES.includes(failure.code)) return failCounted(failure.code);
      throw failure;
    }
    const data = res.data as { class_group_id?: unknown; status?: unknown } | null;
    if (!data || typeof data.class_group_id !== 'string' || typeof data.status !== 'string') {
      throw new ApiFailure('internal_error');
    }
    return ctx.json({ class_group_id: data.class_group_id, status: data.status });
  },
});

if (import.meta.main) {
  const { prodP2Deps } = await import('../_shared_p2/prod.ts');
  const deps = prodP2Deps();
  Deno.serve((req) => handler(req, deps));
}
