import { router, useLocalSearchParams } from 'expo-router';
import { ActionBar, Banner, Button, Card, EmptyState, ListItem, Pill, Screen, SkeletonList, Text, useOverlay } from '../../../components';
import { useMyClassGroups } from '../../../features/class/api';
import { shareSubject } from '../../../features/subjects/api';
import { t } from '../../../i18n';

/** S-TUR-01 Turma: list + Criar / Entrar (SOC-01). With ?shareSubjectId it picks a Turma to share into. */
export default function ClassList() {
  const { shareSubjectId } = useLocalSearchParams<{ shareSubjectId?: string }>();
  const groups = useMyClassGroups();
  const overlay = useOverlay();
  const active = (groups.data ?? []).filter((g) => g.membership.status === 'active');

  const share = async (classGroupId: string) => {
    if (!shareSubjectId) return;
    if (!(await overlay.confirm({ title: t('subjects.share_with_class'), message: t('class.share_subject'), confirmLabel: t('subjects.share_with_class') }))) return;
    try {
      await shareSubject(shareSubjectId, classGroupId);
      overlay.snack(t('global.done'));
      router.replace(`/class/${classGroupId}`);
    } catch {
      overlay.snack(t('error.permission'));
    }
  };

  return (
    <Screen
      title={t('class.title')}
      root={!shareSubjectId}
      largeTitle={!shareSubjectId}
      onRefresh={groups.refetch}
      refreshing={groups.isRefetching}
      footer={
        <ActionBar>
          <Button icon="enter-outline" label={t('class.join')} onPress={() => router.push('/class/join')} />
          <Button variant="secondary" icon="add" label={t('class.create')} onPress={() => router.push('/class/create')} />
        </ActionBar>
      }
    >
      {shareSubjectId ? <Banner kind="info" message={t('class.share_subject')} /> : null}
      {groups.isLoading ? <SkeletonList rows={3} /> : null}
      {groups.isFetched && !(groups.data ?? []).length ? (
        <>
          <EmptyState icon="people-outline" title={t('class.explainer_title')} message={t('class.explainer_body')} />
          <Text tone="secondary" align="center">
            {t('class.empty')}
          </Text>
        </>
      ) : null}
      {(groups.data ?? []).map((g) => (
        <Card key={g.id}>
          <ListItem
            icon="people-outline"
            title={g.name}
            subtitle={g.membership.status === 'pending' ? t('class.join_pending') : t(`class.roles.${g.membership.role}`)}
            onPress={g.membership.status === 'active' ? () => (shareSubjectId ? void share(g.id) : router.push(`/class/${g.id}`)) : undefined}
            right={g.membership.status === 'pending' ? <Pill icon="time-outline" text={t('global.loading').replace('…', '')} /> : undefined}
          />
        </Card>
      ))}
      {shareSubjectId && !active.length ? <Text tone="secondary">{t('class.empty')}</Text> : null}
    </Screen>
  );
}
