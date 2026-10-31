import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { uuidv7 } from 'uuidv7';
import { ActionBar, Button, Card, Row, Screen, SessionProgress, Text, useOnline, useOverlay } from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { enqueueOutbox } from '../../db/outbox';
import { useSession } from '../../features/auth/session';
import { updatePlanItem } from '../../features/goals/api';
import { enemRoute } from '../../features/enem/format';
import { useTodayPlan, type TodayItem } from '../../features/goals/today';
import { buildLocalQueue } from '../../features/memory/local';
import { createQuiz } from '../../features/practice/api';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';
import { WellbeingNudge } from '../../features/wellbeing/WellbeingNudge';

interface Block {
  key: string;
  kind: 'review' | 'learn' | 'practice';
  label: string;
  minutes: number;
  item?: TodayItem;
  needsInternet: boolean;
}

const REVIEW_SECONDS = 8;

/**
 * S-HOJE-02 Sessão (GOL-05.2–05.3): due reviews first, then learning and practice for the most
 * urgent test. Each block opens its own screen; coming back marks it done. Leaving saves progress.
 */
export default function SessionRunner() {
  const { minutes: limitParam } = useLocalSearchParams<{ minutes?: string }>();
  const db = useDb();
  const { userId } = useSession();
  const plan = useTodayPlan();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors } = useTheme();
  const sessionId = useRef(uuidv7());
  const startedAt = useRef(Date.now());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<string | null>(null);
  const limit = limitParam ? Number(limitParam) : null;

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const due = buildLocalQueue(db).length;
    let budget = limit ?? Infinity;
    if (due) {
      const m = Math.max(2, Math.round((due * REVIEW_SECONDS) / 60));
      out.push({ key: 'review', kind: 'review', label: t('today.reviews_due', { n: due }), minutes: Math.min(m, budget), needsInternet: false });
      budget -= m;
    }
    for (const item of plan.items.filter((i) => i.status === 'planned')) {
      if (budget <= 0) break;
      const kind = item.unitType === 'practice' || item.unitType === 'mock' ? 'practice' : item.unitType === 'review' || item.unitType === 'warmup' ? 'review' : 'learn';
      if (kind === 'review' && out.some((b) => b.kind === 'review')) continue;
      out.push({ key: item.id, kind, label: item.title, minutes: item.minutes, item, needsInternet: kind !== 'review' });
      budget -= item.minutes;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, plan.items.length, limit]);

  // Coming back from a block screen marks it done and updates the plan item live (GOL-05.3).
  useFocusEffect(
    useCallback(() => {
      if (!running) return;
      const b = blocks.find((x) => x.key === running);
      setDone((d) => new Set(d).add(running));
      if (b?.item) void updatePlanItem(b.item.id, { status: 'done' }).catch(() => undefined);
      setRunning(null);
    }, [running, blocks]),
  );

  const open = async (b: Block) => {
    if (b.needsInternet && !online) {
      setDone((d) => new Set(d).add(b.key));
      overlay.snack(t('session.needs_internet'));
      return;
    }
    setRunning(b.key);
    if (b.kind === 'review') {
      router.push({ pathname: '/review', params: { source: 'session' } });
      return;
    }
    const item = b.item!;
    const enem = enemRoute(item);
    if (enem) {
      router.push(enem);
      return;
    }
    if (b.kind === 'learn' && item.subjectId && item.nodeIds[0]) {
      router.push({ pathname: '/subjects/[subjectId]/topic/[nodeId]', params: { subjectId: item.subjectId, nodeId: item.nodeIds[0] } });
      return;
    }
    if (item.unitType === 'upload_material' && item.subjectId) {
      router.push(`/subjects/${item.subjectId}/upload`);
      return;
    }
    try {
      const res = await createQuiz({
        kind: item.unitType === 'mock' ? 'mock_exam' : 'practice',
        scope: { subject_id: item.subjectId ?? undefined, node_ids: item.nodeIds.length ? item.nodeIds : undefined, exam_id: item.examId ?? undefined },
        count: Math.max(5, Math.min(20, Math.round(item.minutes / 1.5))),
        mode: item.unitType === 'mock' ? 'exam_conditions' : 'practice',
      });
      router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch {
      setRunning(null);
      overlay.snack(t('error.generation'));
    }
  };

  const finish = () => {
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
    if (userId) {
      try {
        void enqueueOutbox(db, {
        kind: 'study_session',
        id: sessionId.current,
        payload: { id: sessionId.current, user_id: userId, kind: 'session', started_at: new Date(startedAt.current).toISOString(), ended_at: new Date().toISOString(), active_minutes: minutes, activities: [...done].map((k) => ({ type: blocks.find((b) => b.key === k)?.kind, ref_id: k, count: 1 })) },
      });
      } catch {
        // Session log is best-effort; plan items were already updated.
      }
    }
    router.replace({ pathname: '/session/end', params: { minutes: String(minutes), cards: '0', topics: String([...done].filter((k) => blocks.find((b) => b.key === k)?.kind === 'learn').length) } });
  };

  // A session that is only the due cards has nothing to sequence: open the review in place of this screen.
  const loneReview = blocks.length === 1 && blocks[0]!.kind === 'review';
  useEffect(() => {
    if (loneReview) router.replace({ pathname: '/review', params: { source: 'session' } });
  }, [loneReview]);

  const next = blocks.find((b) => !done.has(b.key));
  const progress = blocks.length ? done.size / blocks.length : 1;

  return (
    <Screen
      title={t('session.title')}
      immersive
      onBack={async () => {
        if (done.size === 0 || (await overlay.confirm({ title: t('global.leave_confirm_title'), message: t('session.saved'), confirmLabel: t('global.leave'), cancelLabel: t('global.stay') }))) router.back();
      }}
      footer={
        <ActionBar>
          {next ? <Button label={`${done.size ? t('global.continue') : t('today.start_item')}: ${t(`session.blocks.${next.kind}`)}`} onPress={() => open(next)} /> : <Button label={t('global.done')} onPress={finish} />}
        </ActionBar>
      }
    >
      <SessionProgress value={progress} label={t('session.title')} />
      <WellbeingNudge surface="session" />
      {blocks.length === 0 ? <Text tone="secondary">{t('today.all_clear')}</Text> : null}
      {blocks.map((b, i) => {
        const isDone = done.has(b.key);
        return (
          <Card key={b.key} onPress={isDone ? undefined : () => open(b)} accessibilityLabel={b.label}>
            <Row>
              <Ionicons name={isDone ? 'checkmark-circle' : b.kind === 'review' ? 'flash-outline' : b.kind === 'learn' ? 'book-outline' : 'help-circle-outline'} size={24} color={isDone ? colors.success : colors.primary} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodySmall" tone="secondary">
                  {t('session.block_of', { i: i + 1, n: blocks.length, label: t(`session.blocks.${b.kind}`) })}
                </Text>
                <Text variant="label">{b.label}</Text>
                <Text variant="bodySmall" tone="secondary">
                  {b.minutes} min{b.needsInternet && !online ? ` · ${t('offline.ai_disabled')}` : ''}
                </Text>
              </View>
            </Row>
          </Card>
        );
      })}
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
