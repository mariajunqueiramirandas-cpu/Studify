import { router } from 'expo-router';
import { View } from 'react-native';
import { Banner, Card, ProgressBar, Row, Text } from '../../components';
import { t } from '../../i18n';
import type { AiJob, DocumentRow } from './api';
import { ingestionView } from './progress';

export { ingestionJob, ingestionView, stageLabel, type IngestionView } from './progress';

export function isJobActive(job: AiJob | undefined): boolean {
  return !!job && !['succeeded', 'failed', 'cancelled'].includes(job.status);
}

/** S-MAT-03 processing card: stage + progress bar + count (ux §5.4). Tap → S-MAT-05. */
export function ProcessingCard({ subjectId, job, documents }: { subjectId: string; job: AiJob | undefined; documents: DocumentRow[] }) {
  const pending = documents.filter((d) => d.status === 'uploaded' || d.status === 'processing');
  const failed = documents.filter((d) => d.status === 'failed');
  const waiting = documents.some((d) => d.status === 'waiting_budget') || job?.status === 'waiting_budget';
  if (waiting) {
    return <Banner kind="warning" message={t('ingest.waiting_budget')} action={{ label: t('ingest.processing_title'), onPress: () => router.push(`/subjects/${subjectId}/processing`) }} />;
  }
  if (failed.length && !isJobActive(job)) {
    return <Banner kind="danger" message={t('ingest.failed')} action={{ label: t('global.retry'), onPress: () => router.push(`/subjects/${subjectId}/processing`) }} />;
  }
  if (!isJobActive(job) && !pending.length) return null;
  const view = ingestionView(job, pending[0]);
  return (
    <Card onPress={() => router.push(`/subjects/${subjectId}/processing`)} accessibilityLabel={view.label} tone="soft">
      <Row>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="label">{view.label}</Text>
          <ProgressBar value={view.fraction} label={view.label} />
        </View>
      </Row>
    </Card>
  );
}
