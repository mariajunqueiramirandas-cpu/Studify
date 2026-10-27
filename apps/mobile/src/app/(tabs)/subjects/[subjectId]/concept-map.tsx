import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { supabase } from '../../../../api/supabase';
import { Banner, Card, EmptyState, ListItem, Screen, SegmentedControl, Text } from '../../../../components';
import { rows } from '../../../../features/common/query';
import { useMastery, useOutline } from '../../../../features/subjects/outline';
import { t } from '../../../../i18n';
import { masteryColor, masteryLabel, radius, space, useTheme } from '../../../../theme';

const COL_W = 150;
const ROW_H = 76;

/** S-MAT-14 Mapa de conceitos + prerequisite detective (LRN-04). */
export default function ConceptMap() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const outline = useOutline(subjectId);
  const mastery = useMastery(subjectId);
  const { colors } = useTheme();
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const topicIds = (outline.data?.topics ?? []).map((n) => n.id);
  const edges = useQuery({
    queryKey: ['subject', subjectId, 'edges'],
    enabled: topicIds.length > 0,
    queryFn: async () => {
      const [prereq, rel] = await Promise.all([
        rows<{ node_id: string; prerequisite_node_id: string }>(supabase.from('node_prerequisites').select('node_id,prerequisite_node_id').in('node_id', topicIds)),
        rows<{ from_node_id: string; to_node_id: string; kind: 'related' | 'contrast'; reason: string | null }>(supabase.from('node_relations').select('from_node_id,to_node_id,kind,reason').eq('subject_id', subjectId)),
      ]);
      return { prereq, rel };
    },
  });

  const layout = useMemo(() => {
    const topics = outline.data?.topics ?? [];
    const pre = edges.data?.prereq ?? [];
    const depth = new Map<string, number>();
    const visit = (id: string, seen: Set<string>): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = pre.filter((e) => e.node_id === id).map((e) => e.prerequisite_node_id);
      const d = parents.length ? 1 + Math.max(...parents.map((p) => visit(p, seen))) : 0;
      depth.set(id, d);
      return d;
    };
    topics.forEach((tp) => visit(tp.id, new Set()));
    const cols = new Map<number, string[]>();
    topics.forEach((tp) => cols.set(depth.get(tp.id) ?? 0, [...(cols.get(depth.get(tp.id) ?? 0) ?? []), tp.id]));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [c, ids] of cols) ids.forEach((id, r) => pos.set(id, { x: c * COL_W, y: r * ROW_H }));
    const width = (Math.max(0, ...cols.keys()) + 1) * COL_W;
    const height = Math.max(1, ...[...cols.values()].map((v) => v.length)) * ROW_H;
    return { pos, width, height };
  }, [outline.data, edges.data]);

  // Prerequisite detective (LRN-04): a weak topic whose prerequisite is also weak.
  const detective = useMemo(() => {
    const m = mastery.data;
    if (!m) return null;
    for (const e of edges.data?.prereq ?? []) {
      const a = m.get(e.node_id)?.mastery;
      const b = m.get(e.prerequisite_node_id)?.mastery;
      if (a != null && a < 0.5 && (b == null || b < 0.6)) return { a: e.node_id, b: e.prerequisite_node_id };
    }
    return null;
  }, [mastery.data, edges.data]);

  const title = (id: string) => outline.data?.byId.get(id)?.title ?? '…';
  if (outline.isFetched && !topicIds.length) return <Screen title={t('concept_map.title')}><EmptyState message={t('concept_map.empty')} /></Screen>;

  return (
    <Screen title={t('concept_map.title')}>
      {detective ? (
        <Banner
          kind="info"
          message={t('concept_map.detective', { a: title(detective.a), b: title(detective.b) })}
          action={{ label: t('concept_map.detective_cta', { b: title(detective.b) }), onPress: () => router.push(`/subjects/${subjectId}/topic/${detective.b}`) }}
        />
      ) : null}
      <SegmentedControl
        value={view}
        onChange={setView}
        options={[
          { value: 'graph', label: t('memory_map.graph_view') },
          { value: 'list', label: t('memory_map.list_view') },
        ]}
      />
      {view === 'graph' ? (
        <ScrollView horizontal>
          <View style={{ width: layout.width + 20, height: layout.height + 20 }}>
            <Svg width={layout.width + 20} height={layout.height + 20} style={{ position: 'absolute' }}>
              {(edges.data?.prereq ?? []).map((e, i) => {
                const a = layout.pos.get(e.prerequisite_node_id);
                const b = layout.pos.get(e.node_id);
                if (!a || !b) return null;
                return <Line key={`p${i}`} x1={a.x + COL_W - 16} y1={a.y + 28} x2={b.x} y2={b.y + 28} stroke={colors.border} strokeWidth={2} />;
              })}
              {(edges.data?.rel ?? []).filter((r) => r.kind === 'contrast').map((e, i) => {
                const a = layout.pos.get(e.from_node_id);
                const b = layout.pos.get(e.to_node_id);
                if (!a || !b) return null;
                return <Line key={`c${i}`} x1={a.x + 60} y1={a.y + 50} x2={b.x + 60} y2={b.y + 50} stroke={colors.warning} strokeWidth={2} strokeDasharray="5 4" />;
              })}
            </Svg>
            {[...layout.pos.entries()].map(([id, p]) => {
              const m = mastery.data?.get(id)?.mastery;
              return (
                <Pressable
                  key={id}
                  onPress={() => router.push(`/subjects/${subjectId}/topic/${id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`${title(id)}: ${masteryLabel(m)}`}
                  style={{ position: 'absolute', left: p.x, top: p.y, width: COL_W - 16, minHeight: 56, borderRadius: radius.md, padding: space.sm, backgroundColor: colors.surface1, borderWidth: 2, borderColor: masteryColor(m ?? null, colors) }}
                >
                  <Text variant="caption" numberOfLines={3}>
                    {title(id)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : (
        (outline.data?.topics ?? []).map((tp) => {
          const pre = (edges.data?.prereq ?? []).filter((e) => e.node_id === tp.id).map((e) => title(e.prerequisite_node_id));
          return <ListItem key={tp.id} title={tp.title} subtitle={pre.length ? `${t('concept_map.prereq')}: ${pre.join(', ')}` : masteryLabel(mastery.data?.get(tp.id)?.mastery)} onPress={() => router.push(`/subjects/${subjectId}/topic/${tp.id}`)} />;
        })
      )}
      {(edges.data?.rel ?? []).some((r) => r.kind === 'contrast') ? (
        <Card>
          <Text variant="label">não confunda</Text>
          {(edges.data?.rel ?? []).filter((r) => r.kind === 'contrast').map((r, i) => (
            <Text key={i} variant="bodySmall">{`${title(r.from_node_id)} × ${title(r.to_node_id)}${r.reason ? ` — ${r.reason}` : ''}`}</Text>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
