import { router } from 'expo-router';
import { Card, ListItem, Screen, Section } from '../../../components';
import { useLive } from '../../../db/hooks';
import { dueCount } from '../../../features/memory/local';
import { useMistakes } from '../../../features/practice/api';
import { t } from '../../../i18n';

/** S-PRA-01 Praticar hub. */
export default function PracticeHub() {
  const due = useLive((d) => dueCount(d), { tables: ['card_states', 'cards'] });
  const mistakes = useMistakes('open');
  const open = mistakes.data?.length ?? 0;
  return (
    <Screen title={t('tab.practice')} root largeTitle>
      <Card>
        <ListItem icon="flash-outline" title={t('review.start')} subtitle={due.data ? t('today.reviews_due', { n: due.data }) : t('review.all_done')} onPress={() => router.push('/review')} />
        <ListItem icon="help-circle-outline" title="Fazer quiz" onPress={() => router.push('/practice/quiz/new')} />
        <ListItem icon="timer-outline" title="Simulado" onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mock_exam' } })} />
        <ListItem icon="camera-outline" title={t('cam.title')} subtitle={t('cam.practice_hint')} onPress={() => router.push('/camera')} />
        <ListItem icon="create-outline" title={t('essay.entry')} subtitle={t('essay.entry_hint')} onPress={() => router.push('/essay/new')} />
        <ListItem icon="refresh-outline" title={t('mistakes.retry')} subtitle={open ? `${open}` : undefined} disabled={!open} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mistake_retry' } })} />
      </Card>
      <Section title="Mais">
        <Card>
          <ListItem icon="book-outline" title={t('mistakes.title')} onPress={() => router.push('/practice/mistakes')} />
          <ListItem icon="chatbubbles-outline" title={t('tutor.threads')} onPress={() => router.push('/practice/tutor')} />
          <ListItem icon="albums-outline" title={t('feed.title')} onPress={() => router.push('/feed')} />
          <ListItem icon="sparkles-outline" title={t('memory_map.title')} onPress={() => router.push('/practice/memory-map')} />
          <ListItem icon="speedometer-outline" title={t('calibration.title')} onPress={() => router.push('/practice/calibration')} />
        </Card>
      </Section>
    </Screen>
  );
}
