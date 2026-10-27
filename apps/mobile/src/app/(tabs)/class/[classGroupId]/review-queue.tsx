import { useLocalSearchParams } from 'expo-router';
import { AiBadge, Button, Card, EmptyState, PageChips, Row, Screen, SkeletonList, Text, useOverlay } from '../../../../components';
import { resolveFlag, useReviewQueue } from '../../../../features/class/api';
import { options, t } from '../../../../i18n';

const REASON_INDEX: Record<string, number> = { wrong_fact: 0, wrong_answer: 1, unclear: 2, wrong_page: 3, inappropriate: 5, other: 6 };

/** S-TUR-15 Fila de revisão: flag triage for owner/mods/uploader (TRU-02.6–02.8). */
export default function ReviewQueue() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const flags = useReviewQueue(classGroupId);
  const overlay = useOverlay();
  const reasons = options('flag.reasons');
  const decide = async (id: string, decision: 'accept' | 'reject' | 'remove', fix?: unknown) => {
    try {
      await resolveFlag(id, decision, fix);
      overlay.snack(decision === 'accept' ? t('flag.fixed') : t('global.done'));
      void flags.refetch();
    } catch {
      overlay.snack(t('error.permission'));
    }
  };
  return (
    <Screen title={t('class.review_queue')} onRefresh={flags.refetch} refreshing={flags.isRefetching}>
      {flags.isLoading ? <SkeletonList rows={3} height={120} /> : null}
      {flags.isFetched && !flags.data?.length ? <EmptyState icon="checkmark-done-outline" message={t('flag.queue_empty')} /> : null}
      {(flags.data ?? []).map((f) => (
        <Card key={f.id}>
          <Text variant="label">{reasons[REASON_INDEX[f.reason] ?? 6]}</Text>
          {f.comment ? <Text>“{f.comment}”</Text> : null}
          {f.ai_verdict ? (
            <>
              <Text variant="label">{`${t('flag.ai_triage')}: ${f.ai_verdict === 'confirmed' ? 'parece erro' : f.ai_verdict === 'rejected' ? 'parece certo' : 'incerto'}`}</Text>
              {f.ai_explanation ? <Text variant="bodySmall">{f.ai_explanation}</Text> : null}
              <PageChips sources={f.ai_source_pages ?? []} />
              {f.ai_proposed_fix?.fields?.map((fl) => (
                <Text key={fl.name} variant="bodySmall" tone="success">{`${fl.name}: ${fl.value}`}</Text>
              ))}
              <AiBadge />
            </>
          ) : (
            <Text tone="secondary">{t('flag.in_review')}</Text>
          )}
          <Row wrap>
            {f.ai_proposed_fix ? <Button compact label={t('flag.accept_fix')} onPress={() => decide(f.id, 'accept', f.ai_proposed_fix)} /> : null}
            <Button compact variant="tonal" label={t('flag.reject')} onPress={() => decide(f.id, 'reject')} />
            <Button compact variant="text" label={(options('flag.actions')[2] ?? 'Remover item')} onPress={() => decide(f.id, 'remove')} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
