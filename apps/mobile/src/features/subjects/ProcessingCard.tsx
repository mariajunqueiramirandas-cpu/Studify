import { router } from 'expo-router';
import { View } from 'react-native';
import { etaSeconds } from '@studify/shared';
import { Banner, Card, ProgressBar, Row, Text } from '../../components';
import { formatDuration, useElapsed } from '../progress/time';
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
  return <ActiveCard subjectId={subjectId} job={job} document={pending[0]} />;
}

/** The running material on the subject home: its step, the bar and the time left once it can be estimated. */
function ActiveCard({ subjectId, job, document }: { subjectId: string; job: AiJob | undefined; document: DocumentRow | undefined }) {
  const view = ingestionView(job, document);
  const elapsed = useElapsed(job?.started_at ?? job?.created_at);
  const eta = job?.status === 'queued' ? null : etaSeconds(view.fraction, elapsed);
  return (
    <Card onPress={() => router.push(`/subjects/${subjectId}/processing`)} accessibilityLabel={view.label} tone="soft">
      <Row>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="label">{view.label}</Text>
          <ProgressBar value={view.fraction} label={view.label} />
          <Text variant="caption" tone="secondary">
            {job?.status === 'queued' ? t('wait.queued') : eta !== null ? t('wait.eta', { time: formatDuration(eta) }) : t('wait.elapsed', { time: formatDuration(elapsed) })}
          </Text>
        </View>
      </Row>
    </Card>
  );
}
