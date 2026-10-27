import { bossQuestionCount, type SkillNodeState } from '@studify/shared';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { BottomSheet, Button, EmptyState, Screen, SkeletonList, Text, useOnline, useOverlay } from '../../../../components';
import { createQuiz } from '../../../../features/practice/api';
import { useBossAttempts, useSkillTree } from '../../../../features/skilltree/api';
import { t } from '../../../../i18n';
import { radius, space, useTheme } from '../../../../theme';

const CELL_W = 150;
const CELL_H = 92;
const NODE_W = 128;
const NODE_H = 70;

/**
 * S-MOT Mapa (MOT-02): the subject's skill tree. Units are regions, topics are nodes with prerequisite paths, each
 * region ends in its Chefão. Nothing is ever locked: "recomendado depois" only dims a node and names the topic.
 */
export default function SkillTreeMap() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const tree = useSkillTree(subjectId);
  const bosses = useBossAttempts(subjectId);
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c } = useTheme();
  const [boss, setBoss] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!tree) return <Screen title={t('map.title')} onBack={() => router.back()}><SkeletonList rows={4} height={80} /></Screen>;
  if (tree.layout.nodes.length === 0) return <Screen title={t('map.title')} onBack={() => router.back()}><EmptyState icon="map-outline" message={t('map.empty')} /></Screen>;

  const tone: Record<SkillNodeState, { bg: string; border: string; icon: React.ComponentProps<typeof Ionicons>['name'] }> = {
    recommended_later: { bg: c.surface2, border: c.border, icon: 'time-outline' },
    available: { bg: c.bg, border: c.primary, icon: 'ellipse-outline' },
    in_progress: { bg: c.warningSoft, border: c.warning, icon: 'trending-up-outline' },
    mastered: { bg: c.successSoft, border: c.success, icon: 'checkmark-circle' },
    cooling: { bg: c.infoSoft, border: c.info, icon: 'snow-outline' },
  };
  const pos = new Map(tree.layout.nodes.map((n) => [n.id, { x: n.col * CELL_W + space.md, y: n.row * CELL_H + 28 }]));
  const width = tree.layout.cols * CELL_W + space.md * 2;
  const height = (tree.layout.rows + 1) * CELL_H + 40;
  const defeated = new Set((bosses.data ?? []).filter((b) => b.passed).map((b) => b.unit_node_id));

  const fight = async (unitId: string) => {
    setBusy(true);
    try {
      const res = await createQuiz({ kind: 'boss', scope: { subject_id: subjectId, unit_node_id: unitId }, count: 10, mode: 'practice' });
      setBoss(null);
      router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('map.title')} onBack={() => router.back()} scroll={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: space.xl }}>
        <ScrollView horizontal>
          <View style={{ width, height }}>
            <Svg width={width} height={height} style={{ position: 'absolute' }}>
              {tree.layout.edges.map((e) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                return <Line key={`${e.from}-${e.to}`} x1={a.x + NODE_W / 2} y1={a.y + NODE_H / 2} x2={b.x + NODE_W / 2} y2={b.y + NODE_H / 2} stroke={c.border} strokeWidth={2} strokeDasharray="5 4" />;
              })}
            </Svg>
            {tree.layout.regions.map((r) => (
              <View key={r.unitId} style={{ position: 'absolute', left: 0, top: r.firstRow * CELL_H, width, height: r.rows * CELL_H + 24, borderTopWidth: 1, borderColor: c.border }}>
                {r.title ? (
                  <Text variant="caption" tone="secondary" style={{ marginLeft: space.md, marginTop: 4 }}>
                    {r.title}
                  </Text>
                ) : null}
              </View>
            ))}
            {tree.layout.nodes.map((n) => {
              const st = tree.states.get(n.id)!;
              const p = pos.get(n.id)!;
              const look = tone[st.state];
              const m = tree.masteryOf.get(n.id);
              const scope = tree.inScope.has(n.id);
              const label = st.state === 'recommended_later' ? t('map.after', { topic: tree.titles.get(st.recommendedAfter ?? '') ?? '' }) : t(`map.state.${st.state}`);
              return (
                <Pressable
                  key={n.id}
                  onPress={() => router.push({ pathname: '/subjects/[subjectId]/topic/[nodeId]', params: { subjectId, nodeId: n.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`${tree.titles.get(n.id)}. ${label}${scope ? `. ${t('map.in_scope')}` : ''}`}
                  style={{ position: 'absolute', left: p.x, top: p.y, width: NODE_W, height: NODE_H, borderRadius: radius.md, backgroundColor: look.bg, borderWidth: scope ? 3 : 1.5, borderColor: scope ? c.primary : look.border, padding: 6, opacity: st.state === 'recommended_later' ? 0.6 : 1, gap: 2 }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name={look.icon} size={14} color={look.border} />
                    <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                      {st.state === 'in_progress' && m != null ? `${Math.round(m * 100)}%` : scope ? t('map.in_scope') : ''}
                    </Text>
                  </View>
                  <Text variant="bodySmall" numberOfLines={2}>
                    {tree.titles.get(n.id)}
                  </Text>
                </Pressable>
              );
            })}
            {tree.layout.regions
              .filter((r) => r.unitId !== '_')
              .map((r) => {
                const p = { x: r.boss.col * CELL_W + space.md, y: r.boss.row * CELL_H + 28 };
                const won = defeated.has(r.unitId);
                return (
                  <Pressable
                    key={`boss-${r.unitId}`}
                    onPress={() => setBoss(r.unitId)}
                    accessibilityRole="button"
                    accessibilityLabel={t('map.boss', { unit: r.title })}
                    style={{ position: 'absolute', left: p.x + 20, top: p.y, width: NODE_W - 40, height: NODE_H, borderRadius: radius.lg, backgroundColor: won ? c.successSoft : c.primarySoft, borderWidth: 2, borderColor: won ? c.success : c.primary, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name={won ? 'trophy' : 'shield-half-outline'} size={26} color={won ? c.success : c.primary} />
                    <Text variant="caption">{t('map.boss_short')}</Text>
                  </Pressable>
                );
              })}
          </View>
        </ScrollView>
        <View style={{ paddingHorizontal: space.md, gap: 4 }}>
          {(['available', 'in_progress', 'mastered', 'cooling', 'recommended_later'] as const).map((s) => (
            <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Ionicons name={tone[s].icon} size={14} color={tone[s].border} />
              <Text variant="caption" tone="secondary">
                {t(`map.state.${s}`)}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <BottomSheet visible={boss !== null} onClose={() => setBoss(null)} title={t('map.boss', { unit: tree.titles.get(boss ?? '') ?? '' })}>
        <Text>{t('map.boss_intro', { n: bossQuestionCount(tree.topicsByUnit.get(boss ?? '')?.length ?? 0) })}</Text>
        {boss && defeated.has(boss) ? <Text tone="success">{t('map.boss_won')}</Text> : null}
        <Button label={t('map.boss_fight')} loading={busy} disabled={!online} onPress={() => boss && void fight(boss)} />
      </BottomSheet>
    </Screen>
  );
}
