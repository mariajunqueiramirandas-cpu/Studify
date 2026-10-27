import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, BottomSheet, Button, Card, Celebrate, IconButton, ListItem, RadioList, Row, Screen, Section, SkeletonList, Text, useOverlay } from '../../../components';
import { addDays, parseDate, toLocalDate, weekdayDate } from '../../../features/common/format';
import { recomputePlan, updatePlanItem, useGoal, useGoalExams, useInvalidateGoal, usePlanRange, type PlanItem } from '../../../features/goals/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { space, useTheme } from '../../../theme';

const UNIT_KEY: Record<PlanItem['unit_type'], string> = {
  learn: 'learn',
  learn_light: 'learn',
  practice: 'practice',
  mock: 'mock',
  vespera: 'vespera',
  warmup: 'review',
  review: 'review',
  upload_material: 'upload',
  essay: 'practice',
};

/** S-OBJ-09 Plano: week view, long-press to pin, move to another day, triage banner (GOL-04). */
export default function PlanScreen() {
  const { goalId, ready } = useLocalSearchParams<{ goalId: string; ready?: string }>();
  const goal = useGoal(goalId);
  const exams = useGoalExams(goalId);
  const subjects = useSubjects();
  const invalidate = useInvalidateGoal();
  const overlay = useOverlay();
  const { colors } = useTheme();
  const from = toLocalDate(new Date());
  const to = goal.data ? goal.data.end_date : toLocalDate(addDays(new Date(), 14));
  const plan = usePlanRange(from, to);
  const [moving, setMoving] = useState<PlanItem | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [triage, setTriage] = useState<string[] | null>(null);
  const names = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.id, s.name])), [subjects.data]);
  const examDays = new Set((exams.data ?? []).map((e) => e.local_date));

  const days = useMemo(() => {
    const out: string[] = [];
    let d = parseDate(from);
    const end = parseDate(to);
    while (d <= end && out.length < 60) {
      out.push(toLocalDate(d));
      d = addDays(d, 1);
    }
    return out;
  }, [from, to]);
  const byDay = useMemo(() => {
    const m = new Map<string, PlanItem[]>();
    for (const it of plan.data ?? []) m.set(it.local_date, [...(m.get(it.local_date) ?? []), it]);
    return m;
  }, [plan.data]);

  const replan = async () => {
    setBusy(true);
    try {
      const res = await recomputePlan('user_rebalance', goalId);
      if (res.triage?.dropped_node_ids.length) setTriage(res.triage.dropped_node_ids);
      invalidate(goalId);
      void plan.refetch();
    } catch {
      overlay.snack(t('goal.wizard.offline_plan'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('plan.title')}
      onRefresh={plan.refetch}
      refreshing={plan.isRefetching}
      actions={<IconButton icon="refresh-outline" label={t('plan.recompute')} onPress={replan} disabled={busy} />}
      footer={
        <ActionBar>
          <Button label={t('today.start')} icon="play" onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: 'new' } })} />
        </ActionBar>
      }
    >
      {ready ? <Celebrate text={t('plan.ready')} /> : null}
      {triage ? <Banner kind="warning" message={t('plan.tight', { items: `${triage.length} tópicos` })} action={{ label: t('plan.increase_time'), onPress: () => router.push(`/goal/${goalId}/time`) }} onDismiss={() => setTriage(null)} /> : null}
      {plan.isLoading ? <SkeletonList rows={5} height={72} /> : null}
      {days.map((day) => {
        const items = byDay.get(day) ?? [];
        const total = items.filter((i) => i.status === 'planned').reduce((s, i) => s + i.minutes, 0);
        return (
          <Section key={day} title={`${weekdayDate(day)}${examDays.has(day) ? ` · ${t('plan.exam_day')}` : ''}`} action={total ? <Text variant="bodySmall" tone="secondary">{total} min</Text> : null}>
            {items.length === 0 ? <Text variant="bodySmall" tone="secondary">{t('plan.empty_day')}</Text> : null}
            {items.map((it) => (
              <Card key={it.id} style={it.status !== 'planned' ? { opacity: 0.55 } : undefined} onLongPress={() => void updatePlanItem(it.id, { pinned: !it.pinned }).then(() => plan.refetch())}>
                <Row>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="label">{`${t(`plan.units.${UNIT_KEY[it.unit_type]}`)}${it.subject_id ? ` · ${names.get(it.subject_id) ?? ''}` : ''}`}</Text>
                    <Text variant="bodySmall" tone="secondary">
                      {it.minutes} min{it.pinned ? ` · ${t('plan.pinned')}` : ''}
                      {it.status !== 'planned' ? ` · ${t(`plan.status.${it.status}`)}` : ''}
                    </Text>
                    {it.reason_key ? <Text variant="bodySmall" tone="secondary">{t(it.reason_key, { ...(it.reason_params ?? {}), defaultValue: '' })}</Text> : null}
                  </View>
                  {it.status === 'planned' ? <IconButton icon="swap-vertical-outline" label={t('plan.move')} onPress={() => (setMoving(it), setTarget(null))} /> : null}
                  {it.pinned ? <IconButton icon="pin" color={colors.primary} label={t('plan.unpin')} onPress={() => void updatePlanItem(it.id, { pinned: false }).then(() => plan.refetch())} /> : null}
                </Row>
              </Card>
            ))}
          </Section>
        );
      })}
      <BottomSheet
        visible={!!moving}
        onClose={() => setMoving(null)}
        title={t('plan.move_title')}
        footer={
          <Button
            label={t('global.confirm')}
            disabled={!target}
            onPress={async () => {
              await updatePlanItem(moving!.id, { local_date: target!, pinned: true });
              setMoving(null);
              void plan.refetch();
            }}
          />
        }
      >
        <RadioList value={target} onChange={setTarget} options={days.filter((d) => d !== moving?.local_date && !examDays.has(d)).map((d) => ({ value: d, label: weekdayDate(d) }))} />
      </BottomSheet>
      <ListItem icon="time-outline" title={t('time.title')} onPress={() => router.push(`/goal/${goalId}/time`)} />
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
