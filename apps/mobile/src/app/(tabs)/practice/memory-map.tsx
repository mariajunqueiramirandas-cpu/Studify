import { BAND_LABEL_PT, DEFAULT_LEARNING_PARAMS, glowOpacity, retrievability, retrievabilityBand, topicRetrievability, type CardState } from '@studify/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Chip, ChipGroup, EmptyState, ListItem, Screen, SegmentedControl, Text } from '../../../components';
import { useDb } from '../../../db/DatabaseProvider';
import { useLive } from '../../../db/hooks';
import { cards, cardStates, knowledgeNodes } from '../../../db/schema';
import { currentUserId } from '../../../db/hooks/review';
import { addDays } from '../../../features/common/format';
import { options, t } from '../../../i18n';
import { radius, space, useTheme } from '../../../theme';

const HORIZONS = [0, 7, 30];

/** S-PRA-14 Mapa da Memória (MEM-05): topics glow/fade by predicted retention; time slider; list view. Offline. */
export default function MemoryMap() {
  const { subjectId } = useLocalSearchParams<{ subjectId?: string }>();
  const db = useDb();
  const { colors } = useTheme();
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [days, setDays] = useState(0);
  const legend = options('memory_map.legend');

  const data = useLive(
    (d) => {
      const uid = currentUserId(d);
      const nodes = d
        .select({ id: knowledgeNodes.id, title: knowledgeNodes.title, kind: knowledgeNodes.kind, parentId: knowledgeNodes.parentId, subjectId: knowledgeNodes.subjectId })
        .from(knowledgeNodes)
        .where(and(isNull(knowledgeNodes.deletedAt), ...(subjectId ? [eq(knowledgeNodes.subjectId, subjectId)] : [])))
        .all();
      const rows = d
        .select({ cardId: cards.id, nodeId: cards.nodeId, conceptId: cards.conceptId, s: cardStates })
        .from(cards)
        .innerJoin(cardStates, and(eq(cardStates.cardId, cards.id), eq(cardStates.userId, uid)))
        .where(isNull(cards.deletedAt))
        .all();
      return { nodes, rows };
    },
    { tables: ['knowledge_nodes', 'cards', 'card_states'], deps: [subjectId] },
  );

  const topics = useMemo(() => {
    if (!data.data) return [];
    const at = addDays(new Date(), days);
    const byTopic = new Map<string, number[]>();
    for (const r of data.data.rows) {
      if (r.s.state === 0) continue;
      const st: CardState = {
        cardId: r.cardId,
        state: (['new', 'learning', 'review', 'relearning'] as const)[r.s.state] ?? 'new',
        due: r.s.due,
        stability: r.s.stability,
        difficulty: r.s.difficulty,
        reps: r.s.reps,
        lapses: r.s.lapses,
        scheduledDays: r.s.scheduledDays,
        learningSteps: r.s.learningSteps,
        lastReview: r.s.lastReview,
        suspended: r.s.suspended,
      };
      const v = retrievability(st, at, DEFAULT_LEARNING_PARAMS);
      if (v != null) byTopic.set(r.nodeId, [...(byTopic.get(r.nodeId) ?? []), v]);
    }
    return data.data.nodes
      .filter((n) => n.kind === 'topic')
      .map((n) => {
        const vals = byTopic.get(n.id) ?? [];
        const r = topicRetrievability(vals.length ? [{ value: vals.reduce((a, b) => a + b, 0) / vals.length, cardCount: vals.length }] : []);
        return { ...n, r };
      })
      .sort((a, b) => (a.r ?? 2) - (b.r ?? 2));
  }, [data.data, days]);

  const studied = topics.filter((x) => x.r != null);
  if (data.data && !studied.length) {
    return (
      <Screen title={t('memory_map.title')}>
        <EmptyState icon="sparkles-outline" message={t('memory_map.empty')} action={{ label: t('review.start'), onPress: () => router.push('/review') }} />
      </Screen>
    );
  }

  return (
    <Screen title={t('memory_map.title')}>
      <SegmentedControl
        value={view}
        onChange={setView}
        options={[
          { value: 'graph', label: t('memory_map.graph_view') },
          { value: 'list', label: t('memory_map.list_view') },
        ]}
      />
      <ChipGroup>
        {HORIZONS.map((h) => (
          <Chip key={h} label={h === 0 ? t('memory_map.today') : t('memory_map.time_slider', { n: h })} selected={days === h} onPress={() => setDays(h)} />
        ))}
      </ChipGroup>
      <Text variant="bodySmall" tone="secondary">
        {legend.join(' · ')}
      </Text>
      {view === 'graph' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {topics.map((tp) => {
            const band = retrievabilityBand(tp.r);
            return (
              <Pressable
                key={tp.id}
                accessibilityRole="button"
                accessibilityLabel={`${tp.title}: ${BAND_LABEL_PT[band]}${tp.r != null ? `, ${t('memory_map.retention', { pct: Math.round(tp.r * 100) })}` : ''}`}
                onPress={() => router.push({ pathname: '/review', params: { subjectId: tp.subjectId } })}
                style={{
                  width: '31%',
                  minHeight: 88,
                  borderRadius: radius.lg,
                  padding: space.sm,
                  justifyContent: 'space-between',
                  backgroundColor: tp.r == null ? colors.surface2 : `${colors.primary}${Math.round(glowOpacity(tp.r) * 255).toString(16).padStart(2, '0')}`,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Text variant="bodySmall" numberOfLines={3} style={{ color: tp.r != null && tp.r > 0.6 ? colors.onPrimary : colors.textPrimary }}>
                  {tp.title}
                </Text>
                <Text variant="caption" style={{ color: tp.r != null && tp.r > 0.6 ? colors.onPrimary : colors.textSecondary }}>
                  {BAND_LABEL_PT[band]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        topics.map((tp) => (
          <ListItem
            key={tp.id}
            title={tp.title}
            subtitle={`${BAND_LABEL_PT[retrievabilityBand(tp.r)]}${tp.r != null ? ` · ${t('memory_map.retention', { pct: Math.round(tp.r * 100) })}` : ''}`}
            onPress={() => router.push({ pathname: '/review', params: { subjectId: tp.subjectId } })}
          />
        ))
      )}
      {void db}
    </Screen>
  );
}
