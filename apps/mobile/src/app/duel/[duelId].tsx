import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Celebrate, ErrorState, PageChips, QuestionView, RichContent, Row, Screen, Stat, Text, TimerRing, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { duelAnswer, duelNext, respondDuel, useDuel, useMembers, type QuestionPublic } from '../../features/class/api';
import type { QuestionResponse, QuestionRow } from '../../features/practice/types';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';

const QUESTION_MS = 30_000;

type Phase = 'intro' | 'question' | 'feedback' | 'done';

/** S-TUR-10 Duelo (30 s per question, submit on tap) + S-TUR-11 Resultado (SOC-02). Immersive. */
export default function DuelScreen() {
  const { duelId, attemptId: attemptParam } = useLocalSearchParams<{ duelId: string; attemptId?: string }>();
  const { userId } = useSession();
  const duel = useDuel(duelId);
  const members = useMembers(duel.data?.class_group_id);
  const overlay = useOverlay();
  const { colors } = useTheme();
  const [attemptId, setAttemptId] = useState<string | null>(attemptParam ?? null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [q, setQ] = useState<{ index: number; total: number; question: QuestionPublic; deadline: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [fb, setFb] = useState<{ correct: boolean; points: number; explanation: string; correct_response: unknown; source_pages: { document_id: string; page_start: number; page_end: number }[] } | null>(null);
  const [myPoints, setMyPoints] = useState(0);
  const answering = useRef(false);
  const d = duel.data;
  const isChallenger = d?.challenger_id === userId;
  const otherId = d ? (isChallenger ? d.opponent_id : d.challenger_id) : null;
  const otherName = members.data?.find((m) => m.user_id === otherId)?.nickname ?? members.data?.find((m) => m.user_id === otherId)?.display_name ?? '';
  const myAttempt = d ? (isChallenger ? d.challenger_attempt_id : d.opponent_attempt_id) : null;
  const played = !!myAttempt && !attemptId && d?.status !== 'waiting_opponent';

  useEffect(() => {
    if (phase !== 'question') return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [phase]);

  const next = async (aid = attemptId) => {
    if (!aid) return;
    try {
      const res = await duelNext(aid);
      if ('finished' in res) {
        setPhase('done');
        void duel.refetch();
        return;
      }
      setQ({ index: res.index, total: res.total, question: res.question, deadline: new Date(res.deadline_at).getTime() });
      setFb(null);
      setPhase('question');
    } catch {
      overlay.snack(t('error.network'));
    }
  };

  const answer = async (response: QuestionResponse | null) => {
    if (!q || !attemptId || answering.current) return;
    answering.current = true;
    try {
      const res = await duelAnswer(attemptId, q.question.id, response);
      setFb(res);
      setMyPoints((p) => p + res.points);
      setPhase('feedback');
    } catch {
      overlay.snack(t('error.network'));
    } finally {
      answering.current = false;
    }
  };

  // Time's up → empty answer (server scores late answers 0 anyway, SOC-02.4).
  const remaining = q ? q.deadline - now : QUESTION_MS;
  useEffect(() => {
    if (phase === 'question' && remaining <= 0) void answer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, remaining <= 0]);

  if (duel.isError) return <Screen title="" immersive><ErrorState onRetry={duel.refetch} /></Screen>;
  if (!d) return <Screen title="" immersive />;

  const expired = d.status === 'expired' || d.status === 'declined' || d.status === 'cancelled';
  const finished = d.status === 'finished';
  const myScore = isChallenger ? d.challenger_score : d.opponent_score;
  const theirScore = isChallenger ? d.opponent_score : d.challenger_score;
  const pendingInvite = !isChallenger && d.status === 'waiting_opponent' && !d.opponent_attempt_id && !attemptId;

  if (phase === 'question' && q) {
    const asRow = { ...q.question, subject_id: q.question.subject_id, node_id: q.question.node_id } as unknown as QuestionRow;
    return (
      <Screen title={`${q.index + 1}/${q.total}`} immersive actions={<TimerRing totalMs={QUESTION_MS} remainingMs={Math.max(0, remaining)} />}>
        <QuestionView question={asRow} response={null} onChange={() => undefined} submitOnTap={(r) => void answer(r)} />
      </Screen>
    );
  }

  if (phase === 'feedback' && fb && q) {
    return (
      <Screen
        title={`${q.index + 1}/${q.total}`}
        immersive
        footer={
          <ActionBar>
            <Button label={q.index + 1 >= q.total ? t('quiz.finish') : t('quiz.next')} onPress={() => void next()} />
          </ActionBar>
        }
      >
        <Card style={{ borderColor: fb.correct ? colors.success : colors.danger, borderWidth: 2 }}>
          <Text variant="heading">{fb.correct ? t('quiz.correct') : t('quiz.wrong_generic')}</Text>
          <Text variant="label">{t('battle.points', { n: fb.points })}</Text>
          {fb.explanation ? <RichContent variant="reading" text={fb.explanation} /> : null}
          <PageChips sources={fb.source_pages} subjectId={q.question.subject_id} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title={t('duel.challenge').replace(' ⚔️', '')}
      immersive
      footer={
        <ActionBar>
          {pendingInvite ? (
            <>
              <Button
                label={t('duel.accept')}
                onPress={async () => {
                  const r = await respondDuel(duelId, true).catch(() => null);
                  if (r?.attempt_id) {
                    setAttemptId(r.attempt_id);
                    void next(r.attempt_id);
                  }
                }}
              />
              <Button variant="text" label={t('duel.decline')} onPress={async () => (await respondDuel(duelId, false).catch(() => null), router.back())} />
            </>
          ) : attemptId && phase === 'intro' ? (
            <Button label={t('duel.play')} onPress={() => void next()} />
          ) : finished ? (
            <Button label={t('duel.rematch')} onPress={() => router.replace({ pathname: '/class/[classGroupId]/duel-new', params: { classGroupId: d.class_group_id, opponentId: otherId! } })} />
          ) : (
            <Button label={t('global.close')} onPress={() => router.back()} />
          )}
        </ActionBar>
      }
    >
      {phase === 'intro' && (attemptId || pendingInvite) ? <Banner kind="neutral" icon="timer-outline" message={t('duel.timer_notice')} /> : null}
      {pendingInvite ? <Text variant="title">{t('duel.invite_push', { name: otherName, subject: '' }).replace(' de !', '!')}</Text> : null}
      {expired ? <Banner kind="neutral" message={t('duel.expired')} /> : null}
      {finished ? (
        <>
          <Celebrate text={d.winner_id === userId ? t('duel.win') : d.winner_id ? t('duel.loss') : t('duel.tie')} />
          <Card>
            <Row>
              <Stat value={String(myScore ?? 0)} label={t('duel.you')} />
              <Stat value={String(theirScore ?? 0)} label={otherName} />
            </Row>
          </Card>
        </>
      ) : null}
      {(phase === 'done' || played) && !finished && !expired ? (
        <View style={{ gap: space.md }}>
          <Text variant="title">{t('battle.points', { n: myPoints || myScore || 0 })}</Text>
          <Text tone="secondary">{t('duel.waiting', { name: otherName })}</Text>
        </View>
      ) : null}
    </Screen>
  );
}
