import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, BottomSheet, Button, Card, Chip, ChipGroup, RadioList, Screen, Section, Text, useOverlay } from '../../../components';
import { daysBetween, parseDate } from '../../../features/common/format';
import { endDesperate, setDesperateGroups, startDesperate, updateGoal, useDesperateMode, useGoal, useGoalExams, useInvalidateGoal } from '../../../features/goals/api';
import { createQuiz } from '../../../features/practice/api';
import { useOutline } from '../../../features/subjects/outline';
import { options, t } from '../../../i18n';
import { space } from '../../../theme';

type Group = 'focus' | 'basic' | 'out';
const GROUPS: Group[] = ['focus', 'basic', 'out'];
const HOURS = [60, 120, 180, 240];

/** S-OBJ-17 oferta → S-OBJ-18 diagnóstico → S-OBJ-19 plano de ataque (GOL-12). Calm and concrete. */
export default function Desperate() {
  const { goalId } = useLocalSearchParams<{ goalId: string; offer?: string }>();
  const goal = useGoal(goalId);
  const exams = useGoalExams(goalId);
  const mode = useDesperateMode(goalId);
  const invalidate = useInvalidateGoal();
  const overlay = useOverlay();
  const now = new Date();
  const soon = (exams.data ?? []).filter((e) => {
    const d = daysBetween(now, parseDate(e.local_date));
    return d >= 0 && d <= 6 && e.status === 'scheduled';
  });
  const firstSubject = soon[0]?.subject_id ?? undefined;
  const outline = useOutline(firstSubject);
  const [minutes, setMinutes] = useState(120);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ exam_id: string; pct: number }[] | null>(null);
  const groupLabels = options('desperate.groups');
  const hourLabels = options('desperate.time_options');
  const days = soon[0] ? daysBetween(now, parseDate(soon[0].local_date)) : 0;

  const groups = useMemo(() => {
    const g: Record<Group, string[]> = { focus: [], basic: [], out: [] };
    for (const [id, grp] of Object.entries(mode.data?.topic_groups ?? {})) g[grp].push(id);
    return g;
  }, [mode.data]);

  const activate = async () => {
    setBusy(true);
    try {
      const res = await startDesperate(goalId, soon.map((e) => e.id), minutes);
      invalidate(goalId);
      await mode.refetch();
      if (res.diagnostic_quiz_id) router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.diagnostic_quiz_id } });
    } catch {
      overlay.snack(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const diagnostic = async () => {
    setBusy(true);
    try {
      // GOL-12.3: one question per topic, ≤ 12 (≤ 6 when the test is today or tomorrow).
      const res = await createQuiz({ kind: 'practice', scope: { exam_id: soon[0]?.id, subject_id: firstSubject }, count: days <= 1 ? 6 : 12, mode: 'practice' });
      router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch {
      overlay.snack(t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (nodeId: string, group: Group) => {
    if (!mode.data) return;
    setMoving(null);
    try {
      const res = await setDesperateGroups(mode.data.id, [{ node_id: nodeId, group }]);
      setCoverage(res.coverage);
      void mode.refetch();
      invalidate(goalId);
    } catch {
      overlay.snack(t('error.generic'));
    }
  };

  if (!mode.data) {
    return (
      <Screen
        title={t('desperate.offer.title', { n: days })}
        footer={
          <ActionBar>
            <Button label={t('desperate.activate')} loading={busy} disabled={!soon.length} onPress={activate} />
            <Button
              variant="text"
              label={t('desperate.not_now')}
              onPress={async () => {
                // The Hoje card stops offering once dismissed (no nagging, ux §12).
                if (goal.data) await updateGoal(goalId, { settings: { ...goal.data.settings, desperate_offer_dismissed: true } }).catch(() => undefined);
                router.replace({ pathname: '/goal/[goalId]/plan', params: { goalId } });
              }}
            />
          </ActionBar>
        }
      >
        <Text>{t('desperate.offer.body')}</Text>
        <Text variant="label">{t('desperate.time_title')}</Text>
        <ChipGroup>
          {HOURS.map((h, i) => (
            <Chip key={h} label={hourLabels[i] ?? `${h / 60}h`} selected={minutes === h} onPress={() => setMinutes(h)} />
          ))}
        </ChipGroup>
      </Screen>
    );
  }

  const pct = coverage?.[0]?.pct;
  const title = (id: string) => outline.data?.byId.get(id)?.title ?? '…';
  return (
    <Screen
      title={t('desperate.plan_title')}
      footer={
        <ActionBar>
          <Button label={t('today.start')} icon="play" onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: 'new', minutes: '25' } })} />
          <Button variant="text" label={t('desperate.diag.title')} loading={busy} onPress={diagnostic} />
        </ActionBar>
      }
    >
      <Banner kind="info" message={t('desperate.coverage', { hours: `${Math.round(mode.data.minutes_per_day / 60)}h`, pct: pct != null ? Math.round(pct * (pct <= 1 ? 100 : 1)) : '…' })} />
      <Text tone="secondary">{t('desperate.diag.body')}</Text>
      {GROUPS.map((g, i) => (
        <Section key={g} title={groupLabels[i] ?? g}>
          {groups[g].length === 0 ? <Text variant="bodySmall" tone="secondary">—</Text> : null}
          {groups[g].map((id) => (
            <Card key={id} onPress={() => setMoving(id)} accessibilityLabel={`${title(id)}: ${t('desperate.move_to')}`}>
              <Text>{title(id)}</Text>
            </Card>
          ))}
        </Section>
      ))}
      <Text variant="bodySmall" tone="secondary">
        {t('desperate.enough')}
      </Text>
      <Button
        variant="text"
        label="Sair do Modo Desespero"
        onPress={async () => {
          await endDesperate(mode.data!.id).catch(() => undefined);
          invalidate(goalId);
          router.back();
        }}
      />
      <BottomSheet visible={!!moving} onClose={() => setMoving(null)} title={t('desperate.move_to')}>
        <RadioList<Group> value={null} onChange={(g) => moving && move(moving, g)} options={GROUPS.map((g, i) => ({ value: g, label: groupLabels[i] ?? g }))} />
      </BottomSheet>
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
