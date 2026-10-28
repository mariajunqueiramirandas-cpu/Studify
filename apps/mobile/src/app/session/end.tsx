import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActionBar, Button, Celebrate, Row, Screen, Text } from '../../components';
import { useTodayPlan } from '../../features/goals/today';
import { CapiCheer } from '../../features/motivation/CapiCheer';
import { t } from '../../i18n';
import { cheer } from '../../lib/haptics';
import { radius, shade, space, useTheme } from '../../theme';

/** S-HOJE-03 Fim da sessão: summary + next step (GOL-05, MEM-02). */
export default function SessionEnd() {
  const { cards, minutes, questions, topics, kind, calm } = useLocalSearchParams<{ cards?: string; minutes?: string; questions?: string; topics?: string; kind?: string; calm?: string }>();
  const plan = useTodayPlan();
  const next = plan.items.find((i) => i.status === 'planned');
  const n = Number(cards ?? 0);
  const min = Number(minutes ?? 0);
  const { colors: c } = useTheme();
  useEffect(() => {
    if (!calm) cheer();
  }, [calm]);
  return (
    <Screen
      immersive
      calm={!!calm}
      onBack={() => router.replace('/today')}
      footer={
        <ActionBar>
          {next && !calm ? <Button label={`${t('session.next_step')}: ${next.title}`} onPress={() => router.replace('/today')} /> : null}
          <Button variant={next && !calm ? 'text' : 'primary'} label={t('result.back_home')} onPress={() => router.replace('/today')} />
        </ActionBar>
      }
    >
      <View style={{ height: space.xxl }} />
      <CapiCheer happy={!calm} size={150} />
      <Celebrate text={kind === 'review' ? '🎉' : '✅'} calm={!!calm} />
      <Text variant="title" align="center">
        {kind === 'review' ? t('review.done', { n, min: Math.max(1, min) }) : t('session.summary', { min: Math.max(1, min), cards: n, questions: Number(questions ?? 0), topics: Number(topics ?? 0) })}
      </Text>
      <Row gap={space.sm} style={{ alignItems: 'stretch' }}>
        <StatTile value={String(n)} label={t('subjects.cards')} color={c.lamp} fg="#1E2033" />
        {questions ? <StatTile value={questions} label="questões" color={c.primary} fg={c.onPrimary} /> : null}
        <StatTile value={`${Math.max(1, min)} min`} label="tempo" color={c.lagoon} fg={c.onPrimary} />
      </Row>
    </Screen>
  );
}

/** A result tile: its label on a coloured band, the number big underneath. */
function StatTile({ value, label, color, fg }: { value: string; label: string; color: string; fg: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={[styles.tile, { borderColor: color, borderBottomColor: shade(color, 0.25), backgroundColor: c.surface1 }]} accessible accessibilityLabel={`${value} ${label}`}>
      <View style={[styles.band, { backgroundColor: color }]}>
        <Text variant="label" weight="bold" align="center" style={{ color: fg }} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text variant="title" align="center" style={{ paddingVertical: space.md }}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, borderWidth: 2, borderBottomWidth: 5, borderRadius: radius.lg, overflow: 'hidden' },
  band: { paddingVertical: space.xs, paddingHorizontal: space.sm },
});
