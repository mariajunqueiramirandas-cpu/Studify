import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  ActionBar,
  Banner,
  BottomSheet,
  Button,
  Card,
  CountdownChip,
  IconButton,
  ProgressRing,
  RichText,
  Row,
  Screen,
  Section,
  Text,
  useOverlay,
} from '../../../components';
import { useDb } from '../../../db/DatabaseProvider';
import { useLive } from '../../../db/hooks';
import { useSession } from '../../../features/auth/session';
import { daysBetween, greeting, parseDate } from '../../../features/common/format';
import { updatePlanItem, useGoals, useUpcomingExams, type Exam } from '../../../features/goals/api';
import { useTodayPlan, type TodayItem } from '../../../features/goals/today';
import { dueCount } from '../../../features/memory/local';
import { useMotivation } from '../../../features/motivation/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { space, useTheme } from '../../../theme';

/** S-HOJE-01 Hoje (GOL-05): plan, countdowns, ≤ 3 cards, "Começar sessão". */
export default function Today() {
  const { profile } = useSession();
  const db = useDb();
  const plan = useTodayPlan();
  const goals = useGoals();
  const exams = useUpcomingExams();
  const subjects = useSubjects();
  const motivation = useMotivation();
  const overlay = useOverlay();
  const { colors } = useTheme();
  const [quick, setQuick] = useState(false);
  const due = useLive((d) => dueCount(d), { tables: ['card_states', 'cards'] });
  const dueN = due.data ?? 0;
  const activeGoal = goals.data?.[0];
  const subjectName = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.id, s.name])), [subjects.data]);
  const upcoming = (exams.data ?? []).slice(0, 4);
  const pending = plan.items.filter((i) => i.status === 'planned');
  const hasSubjects = (subjects.data ?? []).length > 0;

  // At most 3 cards (ux §4.2): véspera, desespero offer, grade ask, upload.
  const cards = useMemo(() => {
    const out: { key: string; node: React.ReactNode }[] = [];
    const now = new Date();
    const tomorrow = (exams.data ?? []).filter((e) => daysBetween(now, parseDate(e.local_date)) === 1);
    if (tomorrow[0] && now.getHours() >= 15) {
      out.push({
        key: 'vespera',
        node: (
          <Card key="vespera" tone="soft" onPress={() => router.push({ pathname: '/goal/[goalId]/eve/[examId]', params: { goalId: tomorrow[0]!.goal_id, examId: tomorrow[0]!.id } })}>
            <Text variant="heading">{t('vespera.title')}</Text>
            <Text>{t('vespera.notify', { subject: subjectName.get(tomorrow[0]!.subject_id ?? '') ?? tomorrow[0]!.title, minutes: 25 })}</Text>
          </Card>
        ),
      });
    }
    const soon = (exams.data ?? []).find((e) => {
      const d = daysBetween(now, parseDate(e.local_date));
      return d >= 1 && d <= 6;
    });
    if (soon && activeGoal && !activeGoal.settings?.desperate_offer_dismissed) {
      out.push({
        key: 'desperate',
        node: (
          <Card key="desperate" tone="outline" onPress={() => router.push({ pathname: '/goal/[goalId]/desperate', params: { goalId: activeGoal.id } })}>
            <Text variant="heading">{t('desperate.offer.title', { n: daysBetween(now, parseDate(soon.local_date)) })}</Text>
            <Text tone="secondary">{t('desperate.offer.body')}</Text>
          </Card>
        ),
      });
    }
    const graded = (exams.data ?? []).length;
    void graded;
    if (!hasSubjects) {
      out.push({
        key: 'upload',
        node: (
          <Card key="upload" tone="soft" onPress={() => router.push('/subjects/new')}>
            <Text variant="heading">{t('upload.button')}</Text>
            <Text>{t('today.upload_cta')}</Text>
          </Card>
        ),
      });
    }
    return out.slice(0, 3);
  }, [exams.data, activeGoal, hasSubjects, subjectName]);

  const startSession = (minutes?: number) => router.push({ pathname: '/session/[sessionId]', params: { sessionId: 'new', ...(minutes ? { minutes: String(minutes) } : {}) } });

  const toggleItem = async (item: TodayItem, status: 'done' | 'skipped') => {
    try {
      await updatePlanItem(item.id, { status });
      overlay.undo(status === 'done' ? t('today.item_done') : t('today.item_skipped'), () => void updatePlanItem(item.id, { status: 'planned' }));
    } catch {
      overlay.snack(t('offline.queued'));
    }
  };

  return (
    <Screen
      root
      title={greeting(profile?.display_name ?? '')}
      actions={<IconButton icon="trophy-outline" label={t('progress.title')} onPress={() => router.push('/profile/progress')} />}
      context={
        motivation.data ? (
          <Row gap={space.md}>
            <ProgressRing value={Math.min(1, motivation.data.todayMinutes / motivation.data.dailyGoal)} size={36} stroke={5} label={t('goal_daily.label', { n: motivation.data.dailyGoal })} />
            <Text variant="bodySmall" tone="secondary">
              {motivation.data.todayMinutes >= motivation.data.dailyGoal ? t('goal_daily.done') : t('goal_daily.label', { n: motivation.data.dailyGoal })}
              {motivation.data.streak > 0 ? `  ·  ${t('streak.count', { n: motivation.data.streak })}` : ''}
            </Text>
          </Row>
        ) : null
      }
      footer={
        <ActionBar>
          <Button label={pending.length || dueN ? t('today.start') : t('review.start')} icon="play" onPress={() => startSession()} disabled={!pending.length && !dueN} />
          <Button variant="text" label={t('today.quick', { n: 10 }).replace('10', '…')} onPress={() => setQuick(true)} />
        </ActionBar>
      }
    >
      {motivation.data?.streakResetNotice ? <Banner kind="neutral" message={t('streak.reset', { n: motivation.data.bestStreak })} /> : null}
      {upcoming.length ? (
        <Row wrap>
          {upcoming.map((e: Exam) => (
            <Pressable key={e.id} onPress={() => router.push({ pathname: '/goal/[goalId]/exam/[examId]', params: { goalId: e.goal_id, examId: e.id } })} accessibilityRole="button">
              <CountdownChip startsAt={e.starts_at ?? e.local_date} hasTime={!!e.starts_at} label={subjectName.get(e.subject_id ?? '') ?? e.title} />
            </Pressable>
          ))}
        </Row>
      ) : null}

      {dueN > 0 ? (
        <Card onPress={() => router.push('/review')} accessibilityLabel={t('review.start')}>
          <Row>
            <Ionicons name="flash-outline" size={24} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <RichText>{t('review.today', { n: dueN, min: Math.max(1, Math.round((dueN * 8) / 60)) })}</RichText>
            </View>
            <Text variant="label" tone="accent">
              {t('review.start')}
            </Text>
          </Row>
        </Card>
      ) : null}

      {cards.map((c) => c.node)}

      {activeGoal ? (
        <Section
          title={t('today.plan_title')}
          action={<Button compact variant="text" label={t('dashboard.title')} onPress={() => router.push(`/goal/${activeGoal.id}`)} />}
        >
          {plan.items.length ? <Text tone="secondary">{t('today.summary', { minutes: plan.minutes, subjects: plan.subjects })}</Text> : null}
          {plan.items.length === 0 ? <Text tone="secondary">{t('today.nothing_planned')}</Text> : null}
          {plan.items.map((item) => (
            <PlanRow key={item.id} item={item} onDone={() => toggleItem(item, 'done')} onSkip={() => toggleItem(item, 'skipped')} />
          ))}
        </Section>
      ) : (
        <Card tone="soft">
          <Text variant="heading">{t('today.no_goal')}</Text>
          <Button label={t('today.create_goal')} onPress={() => router.push('/goal/new')} />
        </Card>
      )}

      <BottomSheet visible={quick} onClose={() => setQuick(false)} title={t('today.quick_title')}>
        {[10, 20, 30].map((n) => (
          <Button key={n} variant="secondary" label={t('today.quick', { n })} onPress={() => (setQuick(false), startSession(n))} />
        ))}
      </BottomSheet>
      {void db}
    </Screen>
  );
}

function PlanRow({ item, onDone, onSkip }: { item: TodayItem; onDone: () => void; onSkip: () => void }) {
  const { colors } = useTheme();
  const done = item.status !== 'planned';
  return (
    <Card accent={item.subjectColor} style={done ? { opacity: 0.6 } : undefined}>
      <Row>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" style={done ? { textDecorationLine: 'line-through' } : undefined}>
            {item.title}
          </Text>
          <Text variant="bodySmall" tone="secondary">
            {item.minutes} min{item.status === 'done' ? ` · ${t('plan.status.done')}` : item.status === 'skipped' ? ` · ${t('plan.status.skipped')}` : ''}
          </Text>
          {item.reason ? (
            <Text variant="bodySmall" tone="secondary">
              {item.reason}
            </Text>
          ) : null}
        </View>
        {!done ? (
          <>
            <IconButton icon="checkmark-circle-outline" label={`${t('today.item_done')}: ${item.title}`} color={colors.success} onPress={onDone} />
            <IconButton icon="arrow-redo-outline" label={`${t('today.item_skip')}: ${item.title}`} onPress={onSkip} />
          </>
        ) : null}
      </Row>
    </Card>
  );
}
