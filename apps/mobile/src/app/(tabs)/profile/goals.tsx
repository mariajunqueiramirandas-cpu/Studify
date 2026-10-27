import { router } from 'expo-router';
import { ActionBar, Button, Card, EmptyState, ListItem, Screen, Section, useOverlay } from '../../../components';
import { longDate } from '../../../features/common/format';
import { updateGoal, useGoals, useInvalidateGoal } from '../../../features/goals/api';
import { t } from '../../../i18n';

/** S-PERF-02 Objetivos: list, new, archive (GOL-01). */
export default function Goals() {
  const goals = useGoals('all');
  const invalidate = useInvalidateGoal();
  const overlay = useOverlay();
  const active = (goals.data ?? []).filter((g) => g.status === 'active');
  const archived = (goals.data ?? []).filter((g) => g.status !== 'active');
  return (
    <Screen title={t('goal.list_title')} footer={<ActionBar><Button icon="add" label={t('goal.new_goal')} onPress={() => router.push('/goal/new')} /></ActionBar>}>
      {goals.isFetched && !goals.data?.length ? <EmptyState icon="flag-outline" message={t('goal.empty')} /> : null}
      {active.map((g) => (
        <Card key={g.id}>
          <ListItem
            title={g.name}
            subtitle={`${longDate(g.start_date)} – ${longDate(g.end_date)}`}
            onPress={() => router.push(`/goal/${g.id}`)}
            onLongPress={async () => {
              if (await overlay.confirm({ title: t('goal.archive'), message: g.name })) {
                await updateGoal(g.id, { status: 'archived' });
                invalidate(g.id);
              }
            }}
          />
        </Card>
      ))}
      {archived.length ? (
        <Section title={t('goal.archived')}>
          {archived.map((g) => (
            <ListItem key={g.id} title={g.name} subtitle={t(`goal.status.${g.status}`)} onPress={() => router.push(`/goal/${g.id}`)} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
