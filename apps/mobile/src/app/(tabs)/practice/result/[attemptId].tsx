import { router, useLocalSearchParams } from 'expo-router';
import { Share } from 'react-native';
import { shareQuiz } from '../../../../features/class/api';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, AiBadge, Banner, BottomSheet, Button, Card, Celebrate, FeedbackPanel, ListItem, RichContent, RichText, Row, Screen, Section, Stat, Text, useOnline, useOverlay } from '../../../../components';
import { formatGrade } from '../../../../features/common/format';
import { updateMistake, useAttemptResult, useMistakes, type AttemptAnswer } from '../../../../features/practice/api';
import { usePickedCauses } from '../../../../features/practice/causes';
import type { GradeResult, QuestionResponse, QuestionRow } from '../../../../features/practice/types';
import { options, t } from '../../../../i18n';
import { space } from '../../../../theme';
import { CapiCheer } from '../../../../features/motivation/CapiCheer';
import { messageFor } from '../../../../api/messages';

/** S-PRA-07 Resultado + S-PRA-08 Correção (PRA-03, PRA-01.6). */
export default function Result() {
  const { attemptId, k, n, quizId, boss } = useLocalSearchParams<{ attemptId: string; k?: string; n?: string; quizId?: string; boss?: 'won' | 'lost' }>();
  const res = useAttemptResult(attemptId);
  const online = useOnline();
  const mistakes = useMistakes('open');
  const take = usePickedCauses((s) => s.take);
  const overlay = useOverlay();
  const [grading, setGrading] = useState<{ a: AttemptAnswer; q: QuestionRow } | null>(null);

  // Apply the causes picked during the quiz once the server created the mistakes rows.
  useEffect(() => {
    if (!mistakes.data || !attemptId) return;
    const answerIds = new Set((res.data?.answers ?? []).map((a) => a.id));
    const picks = usePickedCauses.getState().byAttempt[attemptId];
    if (!picks || !answerIds.size) return;
    const mine = mistakes.data.filter((m) => answerIds.has(m.attempt_answer_id));
    if (!mine.length) return;
    const taken = take(attemptId);
    for (const m of mine) {
      const c = taken[m.question_id];
      if (c && c !== m.cause) void updateMistake(m.id, { cause: c }).catch(() => undefined);
    }
  }, [mistakes.data, res.data, attemptId, take]);

  // Until quiz-submit has graded the attempt on the server, show the on-device score (k/n params).
  const finalized = res.data?.attempt?.status === 'submitted';
  const answers = finalized ? (res.data?.answers ?? []) : [];
  const correct = answers.length ? answers.filter((a) => a.correct).length : Number(k ?? 0);
  const total = answers.length || Number(n ?? 0);
  const pending = answers.filter((a) => a.grading_status === 'pending').length;
  const wrong = useMemo(() => answers.filter((a) => a.correct === false), [answers]);
  const grade = res.data?.attempt?.grade;

  return (
    <Screen
      title={t('result.title')}
      onRefresh={res.refetch}
      refreshing={res.isRefetching}
      onBack={() => router.replace('/practice')}
      footer={
        <ActionBar>
          {wrong.length ? <Button label={t('result.retry_mistakes')} onPress={() => router.replace({ pathname: '/practice/quiz/new', params: { kind: 'mistake_retry' } })} /> : null}
          <Button variant={wrong.length ? 'text' : 'primary'} label={t('result.back_home')} onPress={() => router.replace('/today')} />
        </ActionBar>
      }
    >
      <CapiCheer happy={boss === 'won' || (!!total && correct / total >= 0.7)} />
      <Celebrate text={boss === 'won' ? '🏆' : total && correct / total >= 0.7 ? '🎉' : '💪'} />
      {boss === 'won' ? <Banner kind="success" message={t('map.boss_defeated')} /> : boss === 'lost' ? <Banner kind="info" message={t('map.boss_again')} /> : null}
      <RichText variant="title" align="center">
        {grade != null ? t('sim.result', { k: correct, n: total, grade: formatGrade(grade) }) : t('result.score', { k: correct, n: total })}
      </RichText>
      {pending ? <Banner kind="info" icon="time-outline" message={t('result.pending_grading', { n: pending })} /> : null}
      {!finalized && !res.isLoading ? <Banner kind="neutral" icon={online ? 'time-outline' : 'cloud-offline-outline'} message={online ? t('grading.progress') : t('offline.queued')} /> : null}
      <Card>
        <Row>
          <Stat value={`${correct}/${total}`} label="acertos" />
          {grade != null ? <Stat value={formatGrade(grade)} label="nota estimada" /> : null}
        </Row>
      </Card>
      {wrong.length ? (
        <Section title={t('result.wrong_answers')}>
          {wrong.map((a) => {
            const q = res.data?.questions.get(a.question_id);
            if (!q) return null;
            const result: GradeResult = { correct: a.correct, score: a.score, typo: null, pending: a.grading_status === 'pending' };
            return (
              <View key={a.id} style={{ gap: space.sm }}>
                <RichContent variant="reading" text={q.stem} />
                {a.ai_feedback ? <Button compact variant="tonal" label={t('grading.title')} onPress={() => setGrading({ a, q })} /> : <FeedbackPanel question={q} response={a.response as QuestionResponse} result={result} />}
              </View>
            );
          })}
        </Section>
      ) : null}
      <Section title={t('result.next_steps')}>
        <Card>
          <ListItem icon="book-outline" title={t('mistakes.title')} onPress={() => router.push('/practice/mistakes')} />
          <ListItem icon="flash-outline" title={t('result.review_cards')} onPress={() => router.push('/review')} />
          <ListItem icon="speedometer-outline" title={t('result.calibration')} onPress={() => router.push('/practice/calibration')} />
          {quizId ? (
            <ListItem
              icon="share-social-outline"
              title={t('share.quiz')}
              onPress={async () => {
                // SOC-09 / S-TUR-17: score card + link; outsiders never see the material.
                try {
                  const s = await shareQuiz(quizId);
                  await Share.share({ message: `${t('share.quiz_card', { k: correct, n: total, subject: '' }).replace(' em  —', ' —')} ${s.url}` });
                } catch (e) {
                  overlay.snack(messageFor(e));
                }
              }}
            />
          ) : null}
        </Card>
      </Section>
      <BottomSheet visible={!!grading} onClose={() => setGrading(null)} title={t('grading.title')}>
        {grading ? (
          <View style={{ gap: space.md }}>
            {grading.a.points_max ? <Text variant="heading">{t('grading.score', { score: formatGrade(grading.a.points_awarded ?? 0), max: formatGrade(grading.a.points_max) })}</Text> : null}
            {(grading.a.ai_feedback?.criteria ?? []).map((c) => (
              <Row key={c.id}>
                <Text>{c.verdict === 'full' ? '✅' : c.verdict === 'partial' ? '🟡' : '❌'}</Text>
                <Text style={{ flex: 1 }}>{c.comment}</Text>
              </Row>
            ))}
            {grading.a.ai_feedback?.sections
              ? options('grading.sections').map((title, i) => {
                  const body = Object.values(grading.a.ai_feedback!.sections!)[i];
                  return body ? (
                    <View key={title} style={{ gap: 4 }}>
                      <Text variant="label">{title}</Text>
                      <RichContent variant="reading" text={body} />
                    </View>
                  ) : null;
                })
              : grading.a.ai_feedback?.summary ? <RichContent variant="reading" text={grading.a.ai_feedback.summary} /> : null}
            <Text variant="bodySmall" tone="secondary">
              {t('grading.disclaimer')}
            </Text>
            <AiBadge />
            <Button variant="text" label={t('grading.dispute')} onPress={() => (setGrading(null), overlay.snack(t('grading.dispute_sent')))} />
          </View>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}
