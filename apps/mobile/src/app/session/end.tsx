import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { ActionBar, Button, Card, Celebrate, Row, Screen, Stat, Text } from '../../components';
import { useTodayPlan } from '../../features/goals/today';
import { t } from '../../i18n';
import { space } from '../../theme';

/** S-HOJE-03 Fim da sessão: summary + next step (GOL-05, MEM-02). */
export default function SessionEnd() {
  const { cards, minutes, questions, topics, kind, calm } = useLocalSearchParams<{ cards?: string; minutes?: string; questions?: string; topics?: string; kind?: string; calm?: string }>();
  const plan = useTodayPlan();
  const next = plan.items.find((i) => i.status === 'planned');
  const n = Number(cards ?? 0);
  const min = Number(minutes ?? 0);
  return (
    <Screen
      immersive
      calm={!!calm}
      onBack={() => router.replace('/today')}
      footer={
        <ActionBar>
          {next && !calm ? <Button label={`${t('session.next_step')}: ${next.title}`} onPress={() => router.replace('/today')} /> : null}
          <Button variant={next && !calm ? 'text' : 'primary'} label={t('result.back_home')} onPress={() => router.replace('/today')} />
        </ActionBar>
      }
    >
      <View style={{ height: space.xxl }} />
      <Celebrate text={kind === 'review' ? '🎉' : '✅'} calm={!!calm} />
      <Text variant="title" align="center">
        {kind === 'review' ? t('review.done', { n, min: Math.max(1, min) }) : t('session.summary', { min: Math.max(1, min), cards: n, questions: Number(questions ?? 0), topics: Number(topics ?? 0) })}
      </Text>
      <Card>
        <Row>
          <Stat value={String(n)} label={t('subjects.cards')} />
          {questions ? <Stat value={questions} label="questões" /> : null}
          <Stat value={`${Math.max(1, min)} min`} label="tempo" />
        </Row>
      </Card>
    </Screen>
  );
}
