import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { rows, rpc } from '../common/query';
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
      const nodes = await rows<KnowledgeNode>(
        supabase.from('knowledge_nodes').select('*').eq('subject_id', subjectId!).is('deleted_at', null).order('position'),
      );
      const ids = nodes.map((n) => n.id);
      const [sources, settings] = ids.length
        ? await Promise.all([
            rows<NodeSource>(supabase.from('node_sources').select('node_id,document_id,page_start,page_end').in('node_id', ids)),
            rows<{ node_id: string; excluded: boolean }>(supabase.from('node_user_settings').select('node_id,excluded').eq('user_id', userId!).in('node_id', ids)),
          ])
        : [[], []];
      return buildOutline(nodes, sources, new Set(settings.filter((s) => s.excluded).map((s) => s.node_id)));
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
  | { op: 'merge'; node_ids: string[]; into_node_id: string; title?: string }
  | { op: 'split'; node_id: string; at_child_id?: string; titles: [string, string] }
  | { op: 'delete'; node_id: string }
  | { op: 'restore'; node_id: string }
  | { op: 'create'; kind: 'unit' | 'topic'; title: string; parent_id?: string | null };

/** ING-04 edits go through `edit_outline` so every change is an undoable node_event. */
export async function editOutline(subjectId: string, ops: OutlineOp[]) {
  return rpc<{ event_ids: string[]; regenerate_node_ids: string[] }>('edit_outline', { subject_id: subjectId, ops });
}

export async function undoOutlineEvent(eventId: string) {
  return rpc<void>('undo_outline_event', { event_id: eventId });
}

/** Per-user "Não cai na prova" (R1) — works on shared subjects too. */
export async function setNodeExcluded(userId: string, nodeId: string, excluded: boolean) {
  const { error } = await supabase
    .from('node_user_settings')
    .upsert({ user_id: userId, node_id: nodeId, excluded, updated_at: new Date().toISOString() }, { onConflict: 'user_id,node_id' });
  if (error) throw error;
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
    queryFn: async () => {
      const { data } = await supabase.from('class_group_members').select('role').eq('class_group_id', groupId!).eq('user_id', userId!).maybeSingle();
      return (data as { role: string } | null)?.role ?? null;
    },
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
      const list = await rows<MasteryRow>(supabase.from('mastery').select('node_id,subject_id,mastery,retrievability,evidence_count,last_evidence_at').eq('user_id', userId!).eq('subject_id', subjectId!));
      return new Map(list.map((m) => [m.node_id, m]));
    },
  });
}
