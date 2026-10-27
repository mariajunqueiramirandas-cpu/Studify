// outline-edit (ING-04, LRN-01). Applies outline operations as the student: edit_outline runs with the
// student's own token (it checks can_edit_subject and writes node_events, so every change can be undone).
// The topics the RPC reports for regeneration (merged or split ones) are queued here, server-side, as
// content.regenerate_topic jobs. Before this function nothing enqueued them.
import { z } from 'zod';
import { RPC_SCHEMAS } from '@studify/shared';
import { defineFunction } from '../_shared/http.ts';

type Req = z.infer<typeof RPC_SCHEMAS.edit_outline.args>;

export interface OutlineEditRes {
  event_ids: string[];
  regenerate_node_ids: string[];
}

export const handler = defineFunction<Req>({
  name: 'outline-edit',
  mutating: true,
  input: RPC_SCHEMAS.edit_outline.args,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;

    // The RPC's parameters are p_subject_id and p_ops (migrations); the client is the student's own.
    const applied = await deps.asUser(ctx.user.jwt).rpc('edit_outline', { p_subject_id: input.subject_id, p_ops: input.ops });
    if (applied.error) throw applied.error;
    const result = applied.data as OutlineEditRes;

    for (const nodeId of result.regenerate_node_ids) {
      await deps.enqueue('content.regenerate_topic', { node_id: nodeId, user_id: userId }, { retryLimit: 2 });
    }

    const body: OutlineEditRes = { event_ids: result.event_ids, regenerate_node_ids: result.regenerate_node_ids };
    return ctx.json(body);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
