// Mapa (MOT-02): units and topics from SQLite (offline), prerequisite edges and boss attempts online when
// available. States and the layout come from @studify/shared, so the picture is stable between visits.
import { useQuery } from '@tanstack/react-query';
import { skillNodeState, skillTreeLayout, type SkillNodeView, type SkillTreeLayout } from '@studify/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { data } from '../../api/data';
import { useLive } from '../../db/hooks/use-live';
import { examScopeNodes, exams, knowledgeNodes, mastery } from '../../db/schema';
import { studyDateOf } from '../../lib/dates';
import { useSession } from '../auth/session';

export interface SkillTreeData {
  layout: SkillTreeLayout;
  states: Map<string, SkillNodeView>;
  titles: Map<string, string>;
  masteryOf: Map<string, number>;
  inScope: Set<string>;
  topicsByUnit: Map<string, string[]>;
}

export function usePrerequisites(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['prereqs', subjectId],
    enabled: !!subjectId,
    staleTime: 10 * 60_000,
    queryFn: () => data<Array<{ node_id: string; prerequisite_node_id: string }>>('skilltree-prereqs', { subject_id: subjectId }),
  });
}

export function useSkillTree(subjectId: string | undefined): SkillTreeData | null {
  const { userId } = useSession();
  const prereqs = usePrerequisites(subjectId);
  const edges = (prereqs.data ?? []).map((e) => ({ nodeId: e.node_id, prerequisiteId: e.prerequisite_node_id }));
  const live = useLive(
    (db) => {
      if (!subjectId) return null;
      const nodes = db.select().from(knowledgeNodes).where(and(eq(knowledgeNodes.subjectId, subjectId), isNull(knowledgeNodes.deletedAt))).all();
      const units = nodes.filter((n) => n.kind === 'unit');
      const topics = nodes.filter((n) => n.kind === 'topic');
      const m = db.select().from(mastery).where(eq(mastery.subjectId, subjectId)).all();
      const today = studyDateOf(Date.now());
      const upcoming = db.select({ id: exams.id }).from(exams).where(and(eq(exams.subjectId, subjectId), isNull(exams.deletedAt))).all();
      const scope = upcoming.length
        ? db.select().from(examScopeNodes).where(inArray(examScopeNodes.examId, upcoming.map((e) => e.id))).all()
        : [];
      return { units, topics, mastery: m, scope, today };
    },
    { tables: ['knowledge_nodes', 'mastery', 'exams', 'exam_scope_nodes'], deps: [subjectId] },
  );
  const d = live.data;
  if (!d || !userId) return null;
  const masteryOf = new Map(d.mastery.filter((r) => r.userId === userId).map((r) => [r.nodeId, r.mastery]));
  const retrievOf = new Map(d.mastery.filter((r) => r.userId === userId).map((r) => [r.nodeId, r.retrievability ?? null]));
  const unitIds = new Set(d.units.map((u) => u.id));
  // Topics whose parent is not a unit (flat outlines) go into one synthetic band.
  const topics = d.topics.map((tp) => ({ id: tp.id, unitId: tp.parentId && unitIds.has(tp.parentId) ? tp.parentId : '_', title: tp.title, order: tp.position }));
  const units = [...d.units.map((u) => ({ id: u.id, title: u.title, order: u.position })), ...(topics.some((tp) => tp.unitId === '_') ? [{ id: '_', title: '', order: 10_000 }] : [])];
  const layout = skillTreeLayout(units, topics, edges);
  const prereqOf = new Map<string, string[]>();
  for (const e of edges) prereqOf.set(e.nodeId, [...(prereqOf.get(e.nodeId) ?? []), e.prerequisiteId]);
  const states = new Map(
    topics.map((tp) => [tp.id, skillNodeState({ id: tp.id, mastery: masteryOf.get(tp.id) ?? null, retrievability: retrievOf.get(tp.id) ?? null, prerequisiteIds: prereqOf.get(tp.id) ?? [] }, (id) => masteryOf.get(id) ?? null)]),
  );
  const topicsByUnit = new Map<string, string[]>();
  for (const tp of topics) topicsByUnit.set(tp.unitId, [...(topicsByUnit.get(tp.unitId) ?? []), tp.id]);
  return {
    layout,
    states,
    titles: new Map([...d.units, ...d.topics].map((n) => [n.id, n.title])),
    masteryOf,
    inScope: new Set(d.scope.filter((s) => s.confirmed !== false).map((s) => s.nodeId)),
    topicsByUnit,
  };
}

export function useBossAttempts(subjectId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['boss-attempts', userId, subjectId],
    enabled: !!userId,
    queryFn: () => data<Array<{ unit_node_id: string; passed: boolean; score: number; created_at: string }>>('skilltree-boss-attempts'),
  });
}
