// S3 prerequisites (ING-03.5, spec 01 §7 T3): standard API, text only, one call per subject. Edges go to
// node_prerequisites. The graph must stay acyclic: an edge that would close a cycle is dropped (ING-03.5).
import { callClaude, type CallResult } from '@studify/ai';
import { getTask } from '@studify/prompts';
import { withTransaction, type Sql } from '../framework/db.ts';
import type { JobContext } from '../framework/types.ts';
import { budgetFor } from './env.ts';
import { listNodes, type NodeRow } from './repo.ts';
import { prepareCall } from './tasks.ts';
import { withShortCache } from '../lib/ai-adapter.ts';

export interface PrereqResult {
  status: 'ok' | 'skipped' | 'failed';
  written: number;
  dropped: number;
}

/** Adds `required → prerequisite` unless it would close a cycle. `edges` maps a node to what it requires. */
export function addEdgeIfAcyclic(edges: Map<string, Set<string>>, node: string, prerequisite: string): boolean {
  if (node === prerequisite) return false;
  // A cycle appears when `node` is already reachable from `prerequisite` through "requires" edges.
  const stack = [prerequisite];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === node) return false;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) stack.push(next);
  }
  const set = edges.get(node) ?? new Set<string>();
  set.add(prerequisite);
  edges.set(node, set);
  return true;
}

export async function runPrerequisites(
  ctx: JobContext,
  input: { subjectId: string; subjectName: string; ownerClassGroupId: string | null; userId: string | null; aiJobId: string | null; uploadedBy: string | null; documentId: string | null },
): Promise<PrereqResult> {
  const sql: Sql = ctx.db;
  const nodes = await listNodes(sql, input.subjectId, true);
  const keyOf = new Map<string, string>();
  nodes.forEach((n, i) => keyOf.set(n.id, `n${i + 1}`));
  const promptNodes = nodes.map((n: NodeRow) => ({
    key: keyOf.get(n.id) as string,
    kind: n.kind,
    title: n.title,
    summary: n.summary,
    parentKey: n.parentId ? keyOf.get(n.parentId) ?? null : null,
  }));
  if (promptNodes.filter((n) => n.kind === 'topic' || n.kind === 'concept').length < 2) {
    return { status: 'skipped', written: 0, dropped: 0 };
  }

  const built = getTask('ingest.prerequisites').build({ subjectName: input.subjectName, nodes: promptNodes });
  const budget = budgetFor(
    { subjectId: input.subjectId, ownerClassGroupId: input.ownerClassGroupId, uploadedBy: input.uploadedBy, documentId: input.documentId },
    { jobId: input.aiJobId, feature: 'ING-03', userId: input.userId },
  );
  const prepared = prepareCall('ingest.prerequisites', built, budget, []);
  const result: CallResult<unknown> = await callClaude(ctx.ai, withShortCache(prepared.call));
  if (result.status !== 'ok') return { status: 'failed', written: 0, dropped: 0 };

  const byKey = new Map(promptNodes.map((n) => [n.key, n]));
  const idOfKey = new Map([...keyOf].map(([id, key]) => [key, id]));
  const data = result.data as { edges: Array<{ node_key: string; prerequisite_key: string }> };
  const edges = new Map<string, Set<string>>();
  // Existing edges count toward the cycle check.
  const existing = await sql.query<{ node_id: string; prerequisite_node_id: string }>(
    `select p.node_id, p.prerequisite_node_id from public.node_prerequisites p
       join public.knowledge_nodes n on n.id = p.node_id
      where n.subject_id = $1 and p.deleted_at is null`,
    [input.subjectId],
  );
  for (const e of existing.rows) addEdgeIfAcyclic(edges, e.node_id, e.prerequisite_node_id);

  let written = 0;
  let dropped = 0;
  const accepted: Array<{ node: string; prerequisite: string }> = [];
  for (const edge of data.edges) {
    const node = byKey.get(edge.node_key);
    const prerequisite = byKey.get(edge.prerequisite_key);
    if (!node || !prerequisite || node.kind !== prerequisite.kind || node.kind === 'unit') {
      dropped++;
      continue;
    }
    const nodeId = idOfKey.get(edge.node_key) as string;
    const prerequisiteId = idOfKey.get(edge.prerequisite_key) as string;
    if (!addEdgeIfAcyclic(edges, nodeId, prerequisiteId)) {
      dropped++;
      continue;
    }
    accepted.push({ node: nodeId, prerequisite: prerequisiteId });
  }
  if (accepted.length > 0) {
    await withTransaction(ctx.db, async (client) => {
      for (const e of accepted) {
        const res = await client.query(
          `insert into public.node_prerequisites (node_id, prerequisite_node_id, origin)
           values ($1, $2, 'ai') on conflict (node_id, prerequisite_node_id) do nothing`,
          [e.node, e.prerequisite],
        );
        written += res.rowCount ?? 0;
      }
    });
  }
  return { status: 'ok', written, dropped };
}
