import { and, eq, inArray, isNull } from 'drizzle-orm';
import { studyDateOf } from '../../lib/dates';
import { useLive } from '../../db/hooks';
import { knowledgeNodes, planItems, subjects } from '../../db/schema';
import { t } from '../../i18n';

export interface TodayItem {
  id: string;
  title: string;
  subjectId: string | null;
  subjectName: string | null;
  subjectColor: string | null;
  examId: string | null;
  nodeIds: string[];
  unitType: string;
  minutes: number;
  status: string;
  pinned: boolean;
  reason: string | null;
}

/** Today's plan from SQLite (works offline; GOL-05.5). The study day rolls over at 04:00. */
export function useTodayPlan(localDate?: string) {
  const day = localDate ?? studyDateOf(Date.now());
  const live = useLive(
    (db) => {
      const items = db
        .select()
        .from(planItems)
        .where(and(eq(planItems.localDate, day), isNull(planItems.deletedAt)))
        .orderBy(planItems.orderInDay)
        .all();
      const subjectIds = [...new Set(items.map((i) => i.subjectId).filter((x): x is string => !!x))];
      const nodeIds = [...new Set(items.flatMap((i) => (i.nodeIds as string[] | null) ?? []))];
      const subs = subjectIds.length ? db.select({ id: subjects.id, name: subjects.name, color: subjects.color }).from(subjects).where(inArray(subjects.id, subjectIds)).all() : [];
      const nodes = nodeIds.length ? db.select({ id: knowledgeNodes.id, title: knowledgeNodes.title }).from(knowledgeNodes).where(inArray(knowledgeNodes.id, nodeIds)).all() : [];
      const sMap = new Map(subs.map((s) => [s.id, s]));
      const nMap = new Map(nodes.map((n) => [n.id, n.title]));
      return items.map<TodayItem>((i) => {
        const ids = (i.nodeIds as string[] | null) ?? [];
        const s = i.subjectId ? sMap.get(i.subjectId) : undefined;
        const unit = t(`plan.units.${i.unitType === 'learn_light' ? 'learn' : i.unitType === 'upload_material' ? 'upload' : i.unitType === 'warmup' ? 'review' : i.unitType}`, { defaultValue: i.unitType });
        const topic = ids.map((id) => nMap.get(id)).filter(Boolean)[0];
        return {
          id: i.id,
          title: [unit, topic ?? s?.name].filter(Boolean).join(': '),
          subjectId: i.subjectId,
          subjectName: s?.name ?? null,
          subjectColor: s?.color ?? null,
          examId: i.examId,
          nodeIds: ids,
          unitType: i.unitType,
          minutes: i.minutes,
          status: i.status,
          pinned: !!i.pinned,
          reason: i.reasonKey ? t(i.reasonKey, { ...((i.reasonParams as Record<string, unknown> | null) ?? {}), defaultValue: '' }) || null : null,
        };
      });
    },
    { tables: ['plan_items', 'subjects', 'knowledge_nodes'], deps: [day] },
  );
  const items = live.data ?? [];
  return {
    day,
    items,
    loading: live.data === undefined,
    minutes: items.filter((i) => i.status === 'planned').reduce((s, i) => s + i.minutes, 0),
    subjects: new Set(items.filter((i) => i.status === 'planned').map((i) => i.subjectId)).size,
  };
}
