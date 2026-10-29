// While a material is still being written, the topics already ready: the student starts on them instead of waiting
// for the whole material (each topic is ready as soon as its own content is written, ADR 0011).
import { router } from 'expo-router';
import { ListItem, Section, Text } from '../../components';
import { t } from '../../i18n';
import { useOutline } from './outline';
import { topicProgress } from './progress';

/** "Já dá pra começar": the ready topics, each one tap away. Nothing once the material is done or before a topic is. */
export function ReadyTopics({ subjectId, max = 5 }: { subjectId: string; max?: number }) {
  const outline = useOutline(subjectId);
  const { ready, writing } = topicProgress(outline.data?.topics ?? []);
  if (ready.length === 0 || writing === 0) return null;
  return (
    <Section title={t('ingest.start_now')}>
      <Text variant="bodySmall" tone="secondary">
        {t('ingest.start_now_hint', { done: ready.length, total: ready.length + writing })}
      </Text>
      {ready.slice(0, max).map((tp) => (
        <ListItem
          key={tp.id}
          icon="checkmark-circle-outline"
          title={tp.title}
          onPress={() => router.push({ pathname: '/subjects/[subjectId]/topic/[nodeId]', params: { subjectId, nodeId: tp.id } })}
        />
      ))}
    </Section>
  );
}
