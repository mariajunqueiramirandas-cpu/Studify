import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, Card, EmptyState, ErrorState, ListItem, Row, Screen, Section, SkeletonList, Text } from '../../components';
import { weekdayDate } from '../../features/common/format';
import { usePlanRange } from '../../features/goals/api';
import { AREAS, enemDatesFor, useEditions, useEnemGoal, useEstimates, useSimuladoHistory, useSisuTargets } from '../../features/enem/api';
import { AreaCard, EstimateFootnote, areaName } from '../../features/enem/components';
import { areaRows, daysUntil } from '../../features/enem/format';
import { studyDateOf } from '../../lib/dates';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

const TILES = [
  { key: 'bank', icon: 'library-outline', route: '/enem/bank' },
  { key: 'simulado', icon: 'timer-outline', route: '/enem/simulado/new' },
  { key: 'essay', icon: 'create-outline', route: '/enem/essay/new' },
  { key: 'sisu', icon: 'school-outline', route: '/enem/sisu' },
  { key: 'atualidades', icon: 'newspaper-outline', route: '/enem/atualidades' },
  { key: 'argument', icon: 'chatbubbles-outline', route: '/argument/new?goalMode=enem' },
  { key: 'repertorio', icon: 'bookmarks-outline', route: '/enem/repertorio' },
  { key: 'reta_final', icon: 'flag-outline', route: '/enem/reta-final' },
] as const;

function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** S-ENEM home (spec 09 §5): countdown, 5 area cards with estimate and Meta SISU target, the week's plan, tools. */
export default function EnemHome() {
  const { goal, isLoading, isError, refetch } = useEnemGoal();
  const editions = useEditions();
  const { estimates } = useEstimates();
  const history = useSimuladoHistory();
  const targets = useSisuTargets(goal?.id);
  const { colors: c } = useTheme();
  // The study day is fixed for the life of the screen (rolls over at 04:00).
  const [today] = useState(() => studyDateOf(Date.now()));
  const week = mondayOf(today);
  const sunday = new Date(`${week}T12:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const plan = usePlanRange(week, sunday.toISOString().slice(0, 10));

  if (isError) return <Screen title={t('enem.title')}><ErrorState onRetry={refetch} /></Screen>;
  if (isLoading) return <Screen title={t('enem.title')}><SkeletonList rows={4} /></Screen>;
  if (!goal) {
    return (
      <Screen title={t('enem.title')} onBack={() => router.back()}>
        <EmptyState icon="school-outline" message={t('enem.wizard.edition_hint')} action={{ label: t('enem.wizard.create'), onPress: () => router.replace({ pathname: '/goal/new', params: { mode: 'enem' } }) }} />
      </Screen>
    );
  }

  const dates = enemDatesFor(goal, editions.data ?? [], today);
  const d1 = dates.day1 ? daysUntil(dates.day1, today) : null;
  const d2 = dates.day2 ? daysUntil(dates.day2, today) : null;
  const countdown =
    d1 === null ? null : d1 > 0 ? t('enem.countdown.day1', { n: d1 }) : d1 === 0 ? t('enem.countdown.today1') : d2 !== null && d2 > 0 ? t('enem.countdown.day2', { n: d2 }) : d2 === 0 ? t('enem.countdown.today2') : t('enem.countdown.done');
  const latest = areaRows(history.data?.[0]?.area_results);
  const target = targets.data?.find((x) => x.priority === 1)?.targets?.display ?? null;
  const weekItems = (plan.data ?? []).filter((i) => i.goal_id === goal.id);
  const nextMock = weekItems.find((i) => i.unit_type === 'mock' && i.status === 'planned' && i.local_date >= today);
  const nextEssay = weekItems.find((i) => i.reason_key === 'enem.plan.essay' && i.status === 'planned' && i.local_date >= today);

  return (
    <Screen title={t('enem.goal.title', { ano: dates.edition?.year ?? goal.name })} onBack={() => router.back()}>
      {countdown ? (
        <Card tone="soft">
          <Text variant="title">{countdown}</Text>
          {dates.day1 ? <Text tone="secondary">{t('enem.dates.day1', { date: weekdayDate(dates.day1) })}{dates.day2 ? ` · ${t('enem.dates.day2', { date: weekdayDate(dates.day2) })}` : ''}</Text> : null}
          {dates.provisional && dates.day1 ? <Banner kind="info" message={t('enem.dates.provisional', { data: weekdayDate(dates.day1) })} /> : null}
        </Card>
      ) : null}

      <Section title={t('enem.home.areas')}>
        {AREAS.map((a) => {
          const r = latest.find((x) => x.area === a);
          return (
            <AreaCard
              key={a}
              area={a}
              score={estimates[a] ?? null}
              low={r?.low}
              high={r?.high}
              target={target?.[a] ?? null}
              onPress={() => router.push({ pathname: '/enem/area/[area]', params: { area: a } })}
            />
          );
        })}
        <AreaCard area="RED" score={estimates.RED ?? null} target={target?.RED ?? null} onPress={() => router.push('/enem/essay/new')} />
        <EstimateFootnote />
      </Section>

      <Section title={t('enem.home.week')}>
        {weekItems.length === 0 ? <Text tone="secondary">{t('enem.home.no_week')}</Text> : null}
        {nextMock ? <Text variant="bodySmall">{t('enem.home.next_simulado', { date: weekdayDate(nextMock.local_date) })}</Text> : null}
        {nextEssay ? <Text variant="bodySmall">{t('enem.home.next_essay', { date: weekdayDate(nextEssay.local_date) })}</Text> : null}
        {weekItems.slice(0, 8).map((i) => (
          <ListItem
            key={i.id}
            title={t(i.reason_key ?? 'plan.units.practice', { ...((i.reason_params ?? {}) as Record<string, unknown>), area: areaName(((i.reason_params?.area as string) ?? 'MT') as 'MT'), defaultValue: t(`plan.units.${i.unit_type}`) })}
            subtitle={`${weekdayDate(i.local_date)} · ${i.minutes} min${i.status === 'done' ? ` · ${t('plan.status.done')}` : ''}`}
          />
        ))}
        <Button compact variant="text" label={t('dashboard.title')} onPress={() => router.push({ pathname: '/goal/[goalId]/plan', params: { goalId: goal.id } })} />
      </Section>

      <Section title={t('enem.home.tools')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {TILES.map((tile) => (
            <Pressable
              key={tile.key}
              accessibilityRole="button"
              onPress={() => router.push(tile.route as never)}
              style={{ width: '47%', minHeight: 72, borderRadius: radius.lg, backgroundColor: c.surface1, padding: space.md, gap: space.xs }}
            >
              <Ionicons name={tile.icon} size={22} color={c.primary} />
              <Text variant="label">{t(`enem.tile.${tile.key}`)}</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      {(history.data ?? []).length > 0 ? (
        <Section title={t('sim.history.title')}>
          {(history.data ?? []).slice(0, 5).map((a) => (
            <ListItem
              key={a.id}
              title={areaRows(a.area_results)
                .map((r) => `${r.area} ${r.score}`)
                .join(' · ')}
              subtitle={a.finished_at ? weekdayDate(a.finished_at.slice(0, 10)) : undefined}
              onPress={() => router.push({ pathname: '/enem/simulado/[attemptId]', params: { attemptId: a.id } })}
            />
          ))}
        </Section>
      ) : null}
      <Row>
        <Text variant="caption" tone="secondary">
          {t('sim.score.label')}
        </Text>
      </Row>
    </Screen>
  );
}
