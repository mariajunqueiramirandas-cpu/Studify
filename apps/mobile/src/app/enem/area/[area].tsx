import type { EnemArea } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { BottomSheet, Button, Card, Chip, ChipGroup, ErrorState, ListItem, Screen, Section, SkeletonList, Text } from '../../../components';
import { usePlanRange } from '../../../features/goals/api';
import { useEnemGoal, useSkillAccuracy, useSkills, useTopicStats, useTopicTrends, type TopicTrendRow } from '../../../features/enem/api';
import { SkillGrid, areaName } from '../../../features/enem/components';
import { skillGrid } from '../../../features/enem/format';
import { studyDateOf } from '../../../lib/dates';
import { t } from '../../../i18n';
import { space } from '../../../theme';

type Tab = 'most' | 'trending' | 'for_you';

/** S-ENEM Área (ENM-01.5, ENM-08.1–08.3): skill grid by competência, ENEM topics with evidence, practice. */
export default function EnemArea() {
  const { area } = useLocalSearchParams<{ area: EnemArea }>();
  const skills = useSkills(area);
  const accuracy = useSkillAccuracy(area);
  const trends = useTopicTrends(area);
  const { goal } = useEnemGoal();
  // The study day is fixed for the life of the screen (rolls over at 04:00).
  const [today] = useState(() => studyDateOf(Date.now()));
  const plan = usePlanRange(today, new Date(Date.parse(`${today}T12:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10));
  const [tab, setTab] = useState<Tab>('most');
  const [skill, setSkill] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);
  const rows = trends.data ?? [];
  const stats = useTopicStats(rows.slice(0, 40).map((r) => r.enem_topic_id));

  const grid = useMemo(() => skillGrid(area, accuracy.data ?? new Map()), [area, accuracy.data]);
  const appeared = useMemo(() => {
    const out = new Map<string, number>();
    const years = [...new Set((stats.data ?? []).map((s) => s.edition_year))].sort((a, b) => b - a).slice(0, 10);
    for (const s of stats.data ?? []) if (years.includes(s.edition_year) && s.item_count > 0) out.set(s.enem_topic_id, (out.get(s.enem_topic_id) ?? 0) + 1);
    return { counts: out, editions: years.length };
  }, [stats.data]);
  const forYou = new Set((plan.data ?? []).filter((i) => i.goal_id === goal?.id && (i.reason_params?.area as string | undefined) === area).map((i) => i.reason_params?.enemTopicId as string | undefined).filter(Boolean));

  const list: TopicTrendRow[] =
    tab === 'most'
      ? [...rows].sort((a, b) => b.share_last10 - a.share_last10).slice(0, 20)
      : tab === 'trending'
        ? rows.filter((r) => r.trend === 'up')
        : rows.filter((r) => forYou.has(r.enem_topic_id));
  const selected = (skills.data ?? []).find((s) => s.code === skill);

  if (skills.isError) return <Screen title={areaName(area)}><ErrorState onRetry={skills.refetch} /></Screen>;
  return (
    <Screen title={areaName(area)} onBack={() => router.back()}>
      <Section title={t('enem.areaScreen.skills')}>{skills.isLoading ? <SkeletonList rows={2} /> : <SkillGrid groups={grid} onPress={setSkill} />}</Section>

      <Section title={t('enem.areaScreen.topics')} action={<Button compact variant="text" label={t('enem.areaScreen.explainer_title')} onPress={() => setExplain(true)} />}>
        <ChipGroup>
          {(['most', 'trending', 'for_you'] as const).map((k) => (
            <Chip key={k} label={t(`enem.areaScreen.${k}`)} selected={tab === k} onPress={() => setTab(k)} />
          ))}
        </ChipGroup>
        {rows.length === 0 && !trends.isLoading ? <Text tone="secondary">{t('enem.areaScreen.no_topics')}</Text> : null}
        {list.map((r) => (
          <ListItem
            key={r.enem_topic_id}
            title={r.enem_topics?.title ?? '—'}
            subtitle={[
              r.enem_topics?.subject,
              t('enem.areaScreen.share', { pct: Math.round(r.share_last10 * 100) }),
              appeared.editions > 0 ? t('enem.areaScreen.appeared', { n: appeared.counts.get(r.enem_topic_id) ?? 0, m: appeared.editions }) : null,
              t(`enem.trend.${r.trend}`),
            ]
              .filter(Boolean)
              .join(' · ')}
            onPress={() => router.push({ pathname: '/enem/bank', params: { area, topicId: r.enem_topic_id, title: r.enem_topics?.title ?? '' } })}
          />
        ))}
      </Section>

      <Button icon="library-outline" label={t('enem.areaScreen.practice_bank')} onPress={() => router.push({ pathname: '/enem/bank', params: { area } })} />
      <Button variant="secondary" icon="timer-outline" label={t('sim.new.title')} onPress={() => router.push({ pathname: '/enem/simulado/new', params: { area } })} />

      <BottomSheet visible={!!selected} onClose={() => setSkill(null)} title={selected?.code ?? ''}>
        {selected ? (
          <View style={{ gap: space.md }}>
            <Text variant="caption" tone="secondary">
              {t('enem.competency', { n: selected.competency_no })}
            </Text>
            <Text>{selected.description ?? t('enem.skill.no_description')}</Text>
            <Button label={t('enem.skill.practice')} onPress={() => (setSkill(null), router.push({ pathname: '/enem/bank', params: { area, skill: selected.code } }))} />
          </View>
        ) : null}
      </BottomSheet>
      <BottomSheet visible={explain} onClose={() => setExplain(false)} title={t('enem.areaScreen.explainer_title')}>
        <Card tone="soft">
          <Text>{t('enem.areaScreen.explainer')}</Text>
        </Card>
      </BottomSheet>
    </Screen>
  );
}
