import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, CountdownChip, EmptyState, IconButton, ListItem, PctRing, Row, Screen, Section, SkeletonList, Text } from '../../../components';
import { formatGrade, longDate, weekdayDate } from '../../../features/common/format';
import { useDesperateMode, useGoal, useGoalExams, useReadiness } from '../../../features/goals/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { space } from '../../../theme';

/** S-OBJ-10 Painel da semana (GOL-08): timeline + test cards with readiness. */
export default function GoalDashboard() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const goal = useGoal(goalId);
  const exams = useGoalExams(goalId);
  const subjects = useSubjects();
  const readiness = useReadiness((exams.data ?? []).map((e) => e.id));
  const desperate = useDesperateMode(goalId);
  const names = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.id, s.name])), [subjects.data]);
  const upcoming = (exams.data ?? []).filter((e) => e.status === 'scheduled');
  // ENEM goals have their own home (S-ENEM-01).
  if (goal.data?.mode === 'enem') return <Redirect href="/enem" />;

  return (
    <Screen
      title={goal.data?.name ?? ''}
      onRefresh={() => (void exams.refetch(), void readiness.refetch())}
      refreshing={exams.isRefetching}
      actions={<IconButton icon="calendar-outline" label={t('dashboard.exams_link')} onPress={() => router.push(`/goal/${goalId}/exams`)} />}
      context={goal.data ? <Text variant="bodySmall" tone="secondary">{`${longDate(goal.data.start_date)} – ${longDate(goal.data.end_date)}`}</Text> : null}
      footer={
        <ActionBar>
          <Button label={t('dashboard.plan_link')} icon="list-outline" onPress={() => router.push(`/goal/${goalId}/plan`)} />
          <Button variant="text" label={t('dashboard.grades_link')} onPress={() => router.push(`/goal/${goalId}/grades`)} />
        </ActionBar>
      }
    >
      {desperate.data ? <Banner kind="warning" icon="flash-outline" message={t('desperate.active_chip')} action={{ label: t('desperate.plan_title'), onPress: () => router.push({ pathname: '/goal/[goalId]/desperate', params: { goalId } }) }} /> : null}
      {exams.isLoading ? <SkeletonList rows={3} height={96} /> : null}
      {exams.isFetched && !upcoming.length ? <EmptyState icon="calendar-outline" message={t('exam.none')} action={{ label: t('exam.add'), onPress: () => router.push(`/goal/${goalId}/exams`) }} /> : null}
      <Section title={t('dashboard.tests')}>
        {upcoming.map((e) => {
          const r = readiness.data?.get(e.id);
          return (
            <Card key={e.id} onPress={() => router.push(`/goal/${goalId}/exam/${e.id}`)} accessibilityLabel={e.title}>
              <Row gap={space.md}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Text variant="heading">{names.get(e.subject_id ?? '') ?? e.title}</Text>
                  <Text variant="bodySmall" tone="secondary">
                    {weekdayDate(e.local_date)}
                  </Text>
                  <CountdownChip startsAt={e.starts_at ?? e.local_date} hasTime={!!e.starts_at} />
                  {e.scope_status !== 'confirmed' ? (
                    <Text variant="bodySmall" tone="warning">
                      {t('scope.default_all').split(' — ')[0]}
                    </Text>
                  ) : null}
                  {r?.pred_low != null && r.pred_high != null ? (
                    <Text variant="bodySmall">{t('predict.range', { low: formatGrade(r.pred_low), high: formatGrade(r.pred_high) })}</Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <PctRing value={r?.readiness ?? null} label={r ? t('readiness.label', { pct: Math.round(r.readiness * 100) }) : undefined} />
                  <Text variant="bodySmall" tone="secondary">
                    Prontidão
                  </Text>
                </View>
              </Row>
            </Card>
          );
        })}
      </Section>
      {readiness.data?.size ? (
        <Text variant="bodySmall" tone="secondary">
          {t('predict.label')}
        </Text>
      ) : null}
      <Card>
        <ListItem icon="calendar-number-outline" title={t('dashboard.exams_link')} onPress={() => router.push(`/goal/${goalId}/exams`)} />
        <ListItem icon="time-outline" title={t('time.title')} onPress={() => router.push(`/goal/${goalId}/time`)} />
        <ListItem icon="calculator-outline" title={t('grade.title')} onPress={() => router.push(`/goal/${goalId}/grades`)} />
      </Card>
    </Screen>
  );
}
