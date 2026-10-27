import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, ProgressBar, Row, Screen, Section, Text, useOverlay } from '../../../../components';
import { DOCUMENT_ERROR_KEYS } from '../../../../features/subjects/errors';
import { retryIngestion, useDocuments, useSubjectJobs } from '../../../../features/subjects/api';
import { useOutline } from '../../../../features/subjects/outline';
import { isJobActive, stageLabel } from '../../../../features/subjects/ProcessingCard';
import { t } from '../../../../i18n';
import { space, useTheme } from '../../../../theme';

const STAGES = ['S0', 'S1', 'S4'] as const;

/** S-MAT-05 Processamento — per-stage progress and errors (ING-03.8). */
export default function Processing() {
  const { subjectId, firstUpload } = useLocalSearchParams<{ subjectId: string; firstUpload?: string }>();
  const docs = useDocuments(subjectId);
  const jobs = useSubjectJobs(subjectId);
  const outline = useOutline(subjectId);
  const overlay = useOverlay();
  const { colors } = useTheme();
  const job = jobs.data?.[0];
  const outlineReady = (outline.data?.roots.length ?? 0) > 0;
  const redirected = useRef(false);

  // After the first upload, the outline review opens as soon as S1 lands (UF-02 step 4).
  useEffect(() => {
    if (firstUpload && outlineReady && !redirected.current) {
      redirected.current = true;
      router.replace({ pathname: '/subjects/[subjectId]/outline-edit', params: { subjectId, fromUpload: '1' } });
    }
  }, [firstUpload, outlineReady, subjectId]);

  const stageIndex = !job ? 0 : job.stage === 'S0' || job.stage === 'transcription' ? 0 : job.stage?.startsWith('S1') ? 1 : 2;
  const done = job?.status === 'succeeded';

  return (
    <Screen
      title={t('ingest.processing_title')}
      onRefresh={() => (void jobs.refetch(), void docs.refetch())}
      footer={
        <ActionBar>
          <Button label={outlineReady ? t('subjects.outline') : t('global.close')} onPress={() => router.replace(`/subjects/${subjectId}`)} />
        </ActionBar>
      }
    >
      <Card tone="soft">
        <Text variant="heading">{stageLabel(job, docs.data?.[docs.data.length - 1])}</Text>
        {isJobActive(job) ? <ProgressBar value={job?.items_total ? (job.items_done ?? 0) / job.items_total : (job?.progress ?? 0.05)} /> : null}
      </Card>
      <Section>
        {STAGES.map((s, i) => {
          const state = done || i < stageIndex ? 'done' : i === stageIndex && isJobActive(job) ? 'active' : 'todo';
          const label = i === 0 ? t('ingest.reading') : i === 1 ? t('ingest.mapping') : t('ingest.stages.content');
          return (
            <Row key={s} gap={space.md}>
              <Ionicons
                name={state === 'done' ? 'checkmark-circle' : state === 'active' ? 'ellipsis-horizontal-circle' : 'ellipse-outline'}
                size={24}
                color={state === 'done' ? colors.success : state === 'active' ? colors.primary : colors.textSecondary}
              />
              <Text tone={state === 'todo' ? 'secondary' : 'primary'}>{label}</Text>
            </Row>
          );
        })}
      </Section>
      <Section title={t('subjects.materials')}>
        {(docs.data ?? []).map((d) => (
          <View key={d.id} style={{ gap: space.xs }}>
            <Text variant="label">{d.title}</Text>
            {d.status === 'failed' ? (
              <Banner
                kind="danger"
                message={t(DOCUMENT_ERROR_KEYS[d.error_code ?? ''] ?? 'ingest.failed')}
                action={
                  d.error_code === 'not_study_material'
                    ? { label: t('ingest.use_anyway'), onPress: () => void retryIngestion(d.id).then(() => jobs.refetch()) }
                    : ['ai_failed', 'ai_refused', null].includes(d.error_code)
                      ? {
                          label: t('global.retry'),
                          onPress: async () => {
                            try {
                              await retryIngestion(d.id);
                              void jobs.refetch();
                              void docs.refetch();
                            } catch {
                              overlay.snack(t('error.generic'));
                            }
                          },
                        }
                      : undefined
                }
              />
            ) : d.status === 'waiting_budget' ? (
              <Banner kind="warning" message={t('ingest.waiting_budget')} />
            ) : (
              <Text variant="bodySmall" tone="secondary">
                {d.status === 'ready' ? t('ingest.ready') : t(`ingest.stages.${d.status === 'uploaded' ? 'uploaded' : 'extracting'}`)}
              </Text>
            )}
          </View>
        ))}
      </Section>
    </Screen>
  );
}
