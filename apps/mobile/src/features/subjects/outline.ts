import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';
import type { SourceRef } from '../../components';

export interface KnowledgeNode {
  id: string;
  subject_id: string;
  parent_id: string | null;
  kind: 'unit' | 'topic' | 'concept';
  title: string;
  summary: string | null;
  position: number;
  learning_objectives: string[];
  key_terms: string[];
  formulas: { latex?: string; label?: string; name?: string }[];
  is_placeholder: boolean;
  est_learn_minutes: number | null;
  content_status: 'pending' | 'generating' | 'ready' | 'failed' | 'skipped_excluded';
  hidden_reason: string | null;
}

export interface NodeSource extends SourceRef {
  node_id: string;
}

export interface OutlineNode extends KnowledgeNode {
  children: OutlineNode[];
  sources: NodeSource[];
  excluded: boolean;
}

export interface Outline {
  roots: OutlineNode[];
  byId: Map<string, OutlineNode>;
  topics: OutlineNode[];
  readyTopics: number;
}

export function buildOutline(nodes: KnowledgeNode[], sources: NodeSource[], excludedIds: Set<string>): Outline {
  const byId = new Map<string, OutlineNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [], sources: [], excluded: excludedIds.has(n.id) });
  for (const s of sources) byId.get(s.node_id)?.sources.push(s);
  const roots: OutlineNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (list: OutlineNode[]) => {
    list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  // A topic excluded by the user hides its concepts too ("não cai na prova", ING-04.6).
  const propagate = (n: OutlineNode, parentExcluded: boolean) => {
    n.excluded = n.excluded || parentExcluded;
    n.children.forEach((c) => propagate(c, n.excluded));
  };
  roots.forEach((r) => propagate(r, false));
  const topics: OutlineNode[] = [];
  const walk = (list: OutlineNode[]) =>
    list.forEach((n) => {
      if (n.kind === 'topic') topics.push(n);
      walk(n.children);
    });
  walk(roots);
  return { roots, byId, topics, readyTopics: topics.filter((t) => t.content_status === 'ready').length };
}

export function useOutline(subjectId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['subject', subjectId, 'outline'],
    enabled: !!subjectId && !!userId,
    queryFn: async () => {
      const res = await data<{ nodes: KnowledgeNode[]; sources: NodeSource[]; excluded: string[] }>('outline-get', { subject_id: subjectId });
      return buildOutline(res.nodes, res.sources, new Set(res.excluded));
    },
    refetchInterval: (q) => (q.state.data && q.state.data.topics.some((t) => t.content_status === 'pending' || t.content_status === 'generating') ? 8000 : false),
  });
}

export function useNode(subjectId: string | undefined, nodeId: string | undefined) {
  const outline = useOutline(subjectId);
  return { ...outline, node: nodeId ? outline.data?.byId.get(nodeId) : undefined };
}

export type OutlineOp =
  | { op: 'rename'; node_id: string; title: string }
  | { op: 'move'; node_id: string; parent_id: string | null; position?: number }
  | { op: 'reorder'; node_id: string; position: number }
  /** [keep, drop]: the keeper absorbs sources, concepts and items (ING-04.3). */
  | { op: 'merge'; node_ids: [string, string] }
  /** Cut the topic before `page`; later sources/items move to the new topic (ING-04.4). */
  | { op: 'split'; node_id: string; page: number; title?: string }
  | { op: 'delete'; node_id: string }
  | { op: 'restore'; node_id: string }
  | { op: 'create'; kind: 'unit' | 'topic'; title: string; parent_id?: string | null };

/**
 * ING-04 edits go through the `outline-edit` function: it runs `edit_outline` as the student (every
 * change is an undoable node_event) and queues regeneration for topics whose sources changed.
 */
export async function editOutline(subjectId: string, ops: OutlineOp[]) {
  return callFunction<{ subject_id: string; ops: OutlineOp[] }, { event_ids: string[]; regenerate_node_ids: string[] }>('outline-edit', { subject_id: subjectId, ops }, { idempotencyKey: uuidv7() });
}

export async function undoOutlineEvent(eventId: string) {
  await data('outline-undo', { event_id: eventId });
}

/** Per-user "Não cai na prova" (R1) — works on shared subjects too. */
export async function setNodeExcluded(_userId: string, nodeId: string, excluded: boolean) {
  await data('nodes-set-excluded', { node_id: nodeId, excluded });
}

export function useInvalidateOutline(subjectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['subject', subjectId, 'outline'] });
}

/** Whether the caller can edit the shared map (owner/mods/uploader) — SOC-01.10. */
export function useCanEditSubject(subject: { owner_profile_id: string | null; owner_class_group_id: string | null; created_by: string } | null | undefined) {
  const { userId } = useSession();
  const groupId = subject?.owner_class_group_id;
  const membership = useQuery({
    queryKey: ['classGroup', groupId, 'myRole', userId],
    enabled: !!groupId && !!userId,
    queryFn: async () => (await data<{ role: string | null }>('subjects-group-role', { class_group_id: groupId })).role,
  });
  if (!subject) return false;
  if (subject.owner_profile_id) return subject.owner_profile_id === userId;
  return subject.created_by === userId || membership.data === 'owner' || membership.data === 'moderator';
}

export interface MasteryRow {
  node_id: string;
  subject_id: string;
  mastery: number;
  retrievability: number | null;
  evidence_count: number;
  last_evidence_at: string | null;
}

/** Per-user mastery per node (MEM-05, GOL-08). Computed server-side, pull only. */
export function useMastery(subjectId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['subject', subjectId, 'mastery', userId],
    enabled: !!subjectId && !!userId,
    queryFn: async () => {
      const list = await data<MasteryRow[]>('subjects-mastery', { subject_id: subjectId });
      return new Map(list.map((m) => [m.node_id, m]));
    },
  });
}
