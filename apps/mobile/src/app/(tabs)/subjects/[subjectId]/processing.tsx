import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, GenerationStatus, Row, Screen, Section, Text, useOverlay } from '../../../../components';
import { DOCUMENT_ERROR_KEYS } from '../../../../features/subjects/errors';
import { retryIngestion, useDocuments, useSubjectJobs } from '../../../../features/subjects/api';
import { useOutline } from '../../../../features/subjects/outline';
import { ingestionJob, ingestionView, isJobActive } from '../../../../features/subjects/ProcessingCard';
import { t } from '../../../../i18n';
import { space, useTheme } from '../../../../theme';
import { messageFor } from '../../../../api/messages';


/** S-MAT-05 Processamento — per-stage progress and errors (ING-03.8). */
export default function Processing() {
  const { subjectId, firstUpload } = useLocalSearchParams<{ subjectId: string; firstUpload?: string }>();
  const docs = useDocuments(subjectId);
  const jobs = useSubjectJobs(subjectId);
  const outline = useOutline(subjectId);
  const overlay = useOverlay();
  const { colors } = useTheme();
  const job = ingestionJob(jobs.data);
  const outlineReady = (outline.data?.roots.length ?? 0) > 0;
  const redirected = useRef(false);

  // After the first upload, the outline review opens as soon as S1 lands (UF-02 step 4).
  useEffect(() => {
    if (firstUpload && outlineReady && !redirected.current) {
      redirected.current = true;
      router.replace({ pathname: '/subjects/[subjectId]/outline-edit', params: { subjectId, fromUpload: '1' } });
    }
  }, [firstUpload, outlineReady, subjectId]);

  const view = ingestionView(job, docs.data?.find((d) => d.id === job?.document_id) ?? docs.data?.[docs.data.length - 1]);

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
      {isJobActive(job) ? (
        <GenerationStatus
          title={t('ingest.processing_title')}
          detail={view.label}
          fraction={job?.status === 'queued' ? null : view.fraction}
          startedAt={job?.started_at ?? job?.created_at}
          queued={job?.status === 'queued'}
          slowAfterS={240}
          canLeave
        />
      ) : (
        <Card tone="soft">
          <Text variant="heading">{view.label}</Text>
        </Card>
      )}
      <Section>
        {view.steps.map(({ label, state }) => (
          <Row key={label} gap={space.md}>
            <Ionicons
              name={state === 'done' ? 'checkmark-circle' : state === 'active' ? 'ellipsis-horizontal-circle' : state === 'failed' ? 'alert-circle' : 'ellipse-outline'}
              size={24}
              color={state === 'done' ? colors.success : state === 'active' ? colors.primary : state === 'failed' ? colors.danger : colors.textSecondary}
            />
            <Text tone={state === 'pending' ? 'secondary' : 'primary'}>{label}</Text>
          </Row>
        ))}
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
                            } catch (e) {
                              overlay.snack(messageFor(e));
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
                {d.status === 'ready' ? t('ingest.ready') : ingestionView(ingestionJob(jobs.data, d.id), d).label}
              </Text>
            )}
          </View>
        ))}
      </Section>
    </Screen>
  );
}
