import { router } from 'expo-router';
import { View } from 'react-native';
import { Banner, Card, ProgressBar, Row, Text } from '../../components';
import { t } from '../../i18n';
import type { AiJob, DocumentRow } from './api';

export function stageLabel(job: AiJob | undefined, doc?: DocumentRow): string {
  if (doc?.status === 'waiting_budget' || job?.status === 'waiting_budget') return t('ingest.stages.waiting_budget');
  if (doc?.status === 'failed' || job?.status === 'failed') return t('ingest.stages.failed');
  if (!job) return doc?.status === 'ready' ? t('ingest.stages.done') : t('ingest.stages.uploaded');
  if (job.status === 'succeeded') return t('ingest.stages.done');
  if (job.status === 'waiting_batch') return t('ingest.stages.waiting_batch');
  switch (job.stage) {
    case 'S0':
    case 'transcription':
      return t('ingest.reading');
    case 'S1':
    case 'S1_merge':
      return t('ingest.mapping');
    case 'S2':
    case 'S3':
    case 'S4':
      return job.items_total ? t('ingest.generating', { done: job.items_done ?? 0, total: job.items_total }) : t('ingest.stages.content');
    default:
      return t('ingest.reading');
  }
}

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
  const progress = job?.items_total ? (job.items_done ?? 0) / job.items_total : (job?.progress ?? 0.05);
  return (
    <Card onPress={() => router.push(`/subjects/${subjectId}/processing`)} accessibilityLabel={stageLabel(job, pending[0])} tone="soft">
      <Row>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="label">{stageLabel(job, pending[0])}</Text>
          <ProgressBar value={progress} label={stageLabel(job, pending[0])} />
        </View>
      </Row>
    </Card>
  );
}
