import { router, useLocalSearchParams } from 'expo-router';
import { ActionBar, Banner, Button, Card, ErrorState, Pill, Row, Screen, SkeletonList, Text, useOnline, useOverlay } from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { useClassGroup } from '../../../../../features/class/api';
import { cancelDividePlan, claimTopic, mergeDividePlan, useDividePlan, useDivideProgress, useSubjectTopics } from '../../../../../features/class/turma5';
import { t } from '../../../../../i18n';
import { useTheme } from '../../../../../theme';

/** SOC-06.1–06.4: claim topics (max per member), write your summaries, and close the divisão into the Resumo da turma. */
export default function DividePlanScreen() {
  const { classGroupId, planId } = useLocalSearchParams<{ classGroupId: string; planId: string }>();
  const plan = useDividePlan(planId);
  const progress = useDivideProgress(planId);
  const topics = useSubjectTopics(plan.data?.subject_id);
  const cg = useClassGroup(classGroupId);
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c } = useTheme();

  if (plan.isError) return <Screen title={t('divide.title')}><ErrorState onRetry={plan.refetch} /></Screen>;
  if (!plan.data) return <Screen title={t('divide.title')}><SkeletonList rows={4} /></Screen>;
  const p = plan.data;
  const byNode = new Map((progress.data ?? []).map((r) => [r.node_id, r]));
  const titleOf = new Map((topics.data ?? []).map((tp) => [tp.id, tp.title]));
  const mine = Object.values(p.assignments).filter((u) => u === userId).length;
  const canClose = p.created_by === userId || !!cg.data?.isMod;
  const refresh = () => Promise.all([plan.refetch(), progress.refetch()]);
  const act = (fn: () => Promise<unknown>) => void fn().then(refresh).catch((e: { message?: string }) => overlay.snack(e.message ?? t('error.generic')));

  return (
    <Screen
      title={p.title}
      onBack={() => router.back()}
      onRefresh={refresh}
      refreshing={plan.isRefetching}
      footer={
        p.status === 'open' && canClose ? (
          <ActionBar>
            <Button label={t('divide.merge')} disabled={!online} onPress={() => act(() => mergeDividePlan(p.id))} />
            <Button variant="text" label={t('divide.cancel')} onPress={() => act(() => cancelDividePlan(p.id))} />
          </ActionBar>
        ) : undefined
      }
    >
      <Banner kind={p.status === 'done' ? 'success' : 'info'} message={t(`divide.status_hint.${p.status}`, { max: p.max_claims, mine })} />
      {p.node_ids.map((nodeId) => {
        const claim = byNode.get(nodeId);
        const isMine = claim?.user_id === userId;
        return (
          <Card key={nodeId} tone={isMine ? 'soft' : 'default'}>
            <Row>
              <Text variant="label" style={{ flex: 1 }}>
                {titleOf.get(nodeId) ?? '…'}
              </Text>
              {claim ? <Pill text={`${claim.nickname ?? '—'} · ${t(`divide.claim.${claim.status}`)}`} color={claim.status === 'approved' ? c.success : undefined} /> : null}
            </Row>
            {p.status === 'open' && !claim && mine < p.max_claims ? <Button compact variant="tonal" label={t('divide.claim_action')} disabled={!online} onPress={() => act(() => claimTopic(p.id, nodeId, true))} /> : null}
            {p.status === 'open' && isMine ? (
              <Row wrap>
                <Button compact label={claim?.status === 'approved' ? t('divide.view_mine') : t('divide.write')} onPress={() => router.push({ pathname: '/class/[classGroupId]/divide/write', params: { classGroupId, planId: p.id, nodeId, title: titleOf.get(nodeId) ?? '' } })} />
                {claim && (claim.status === 'claimed' || claim.status === 'draft') ? <Button compact variant="text" label={t('divide.release')} onPress={() => act(() => claimTopic(p.id, nodeId, false))} /> : null}
              </Row>
            ) : null}
            {p.status === 'done' && plan.data ? (
              <Button compact variant="text" icon="document-text-outline" label={t('divide.open_summary')} onPress={() => router.push({ pathname: '/subjects/[subjectId]/topic/[nodeId]', params: { subjectId: p.subject_id, nodeId } })} />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
