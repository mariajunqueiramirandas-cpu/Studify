import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../../api/functions';
import { ActionBar, Banner, Button, Card, ErrorState, Screen, SkeletonList, Text } from '../../../components';
import { t } from '../../../i18n';

interface SharedOpen {
  quiz_id: string;
  attempt_id: string;
  title: string | null;
  subject_name: string | null;
  question_count: number;
  creator_score?: { k: number; n: number } | null;
  outsider: boolean;
}

/** S-TUR-18 Desafio recebido (SOC-09.1–09.2): outsiders get the questions but never the material. */
export default function SharedQuiz() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [data, setData] = useState<SharedOpen | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    callFunction<{ token: string }, SharedOpen>('quiz-shared-open', { token }, { idempotencyKey: uuidv7() })
      .then(setData)
      .catch(() => setError(true));
  }, [token]);
  if (error) return <Screen title={t('share.received_title')}><ErrorState message={t('error.not_found')} /></Screen>;
  if (!data) return <Screen title={t('share.received_title')}><SkeletonList rows={2} /></Screen>;
  return (
    <Screen
      title={t('share.received_title')}
      footer={
        <ActionBar>
          <Button label={t('share.take')} onPress={() => router.replace({ pathname: '/quiz/[quizId]', params: { quizId: data.quiz_id, attemptId: data.attempt_id } })} />
        </ActionBar>
      }
    >
      <Card>
        <Text variant="heading">{data.title ?? data.subject_name ?? ''}</Text>
        <Text tone="secondary">{`${data.question_count} questões`}</Text>
        {data.creator_score ? <Text>{t('share.quiz_card', { k: data.creator_score.k, n: data.creator_score.n, subject: data.subject_name ?? '' })}</Text> : null}
      </Card>
      {data.outsider ? <Banner kind="neutral" message={t('global.source_class_only')} /> : null}
    </Screen>
  );
}
