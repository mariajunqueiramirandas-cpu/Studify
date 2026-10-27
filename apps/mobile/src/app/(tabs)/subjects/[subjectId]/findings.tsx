import { router, useLocalSearchParams } from 'expo-router';
import { EmptyState, Screen, SkeletonList, Text } from '../../../../components';
import { useFindings } from '../../../../features/material/api';
import { FindingsList } from '../../../../features/material/FindingsList';
import { t } from '../../../../i18n';

/** S-MAT "Avisos do material" (ING-06.2): the checker's possible errors on one document. */
export default function Findings() {
  const { subjectId, documentId, title } = useLocalSearchParams<{ subjectId: string; documentId: string; title?: string }>();
  const findings = useFindings({ documentId });
  return (
    <Screen title={t('findings.title')} onBack={() => router.back()} onRefresh={findings.refetch} refreshing={findings.isRefetching}>
      {title ? (
        <Text variant="bodySmall" tone="secondary">
          {title}
        </Text>
      ) : null}
      <Text variant="caption" tone="secondary">
        {t('findings.intro')}
      </Text>
      {findings.isLoading ? <SkeletonList rows={3} /> : null}
      {!findings.isLoading && (findings.data ?? []).length === 0 ? <EmptyState icon="checkmark-circle-outline" message={t('findings.none')} /> : null}
      <FindingsList documentId={documentId} subjectId={subjectId} />
    </Screen>
  );
}
