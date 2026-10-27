// SOC-06 Dividir e conquistar: loading a contribution for its author and starting the merge job.
import { ApiFailure } from '@studify/shared';
import type { Deps } from '../shared/deps.ts';

export interface ContributionRow {
  id: string;
  divide_plan_id: string;
  node_id: string;
  author_id: string;
  body_md: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

export interface DividePlanRow {
  id: string;
  class_group_id: string;
  subject_id: string;
  node_ids: string[];
  assignments: Record<string, string>;
  status: 'open' | 'merging' | 'done' | 'cancelled';
  created_by: string;
}

/** The author's own contribution and its divisão; anyone else gets not_found (no existence leak). */
export async function loadOwnContribution(deps: Deps, userId: string, contributionId: string): Promise<{ contribution: ContributionRow; plan: DividePlanRow }> {
  const c = await deps.db.from('contributions').select('id, divide_plan_id, node_id, author_id, body_md, status').eq('id', contributionId).maybeSingle();
  if (c.error) throw c.error;
  if (!c.data || c.data.author_id !== userId) throw new ApiFailure('not_found');
  const p = await deps.db.from('divide_plans').select('id, class_group_id, subject_id, node_ids, assignments, status, created_by').eq('id', c.data.divide_plan_id as string).maybeSingle();
  if (p.error) throw p.error;
  if (!p.data) throw new ApiFailure('not_found');
  const member = await deps.db.from('class_group_members').select('status').eq('class_group_id', p.data.class_group_id as string).eq('user_id', userId).maybeSingle();
  if (member.error) throw member.error;
  if (member.data?.status !== 'active') throw new ApiFailure('not_member');
  return { contribution: c.data as ContributionRow, plan: p.data as DividePlanRow };
}

/** Moves an open divisão to merging and queues divide.merge (one job per divisão). */
export async function startMerge(deps: Deps, plan: DividePlanRow): Promise<string | null> {
  const updated = await deps.db.from('divide_plans').update({ status: 'merging' }).eq('id', plan.id).eq('status', 'open').select('id');
  if (updated.error) throw updated.error;
  if (!updated.data || updated.data.length === 0) return null;
  return deps.enqueue('divide.merge', { divide_plan_id: plan.id }, { singletonKey: `divide-merge:${plan.id}`, retryLimit: 2 });
}

/** True when every claimed topic has an approved contribution from its claimer. */
export async function allClaimsApproved(deps: Deps, plan: DividePlanRow): Promise<boolean> {
  const claims = Object.entries(plan.assignments);
  if (claims.length === 0) return false;
  const rows = await deps.db.from('contributions').select('node_id, author_id, status').eq('divide_plan_id', plan.id).eq('status', 'approved');
  if (rows.error) throw rows.error;
  const approved = new Set((rows.data as Array<{ node_id: string; author_id: string }>).map((r) => `${r.node_id}:${r.author_id}`));
  return claims.every(([node, user]) => approved.has(`${node}:${user}`));
}
