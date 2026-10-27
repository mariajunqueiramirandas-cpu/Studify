import { router } from 'expo-router';
import { EmptyState, ErrorState, ListItem, Screen, Section, SkeletonList, SwitchRow } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { weekdayDate } from '../../../features/common/format';
import { useDigests } from '../../../features/enem/api';
import { updateSettings } from '../../../features/profile/api';
import { t } from '../../../i18n';

/** S-ENEM Atualidades (ENM-09.1, 09.5): the weekly digests (newest first) and the opt-in push. */
export default function AtualidadesList() {
  const digests = useDigests();
  const { profile, refreshProfile } = useSession();
  const notify = (profile?.settings as { notify_atualidades?: boolean } | undefined)?.notify_atualidades === true;
  const list = digests.data ?? [];

  return (
    <Screen title={t('atual.title')} onBack={() => router.back()}>
      <SwitchRow label={t('atual.notify')} value={notify} onChange={(v) => void updateSettings({ notify_atualidades: v }).then(() => refreshProfile())} />
      {digests.isError ? <ErrorState onRetry={digests.refetch} /> : null}
      {digests.isLoading ? <SkeletonList rows={3} /> : null}
      {!digests.isLoading && list.length === 0 ? <EmptyState icon="newspaper-outline" message={t('atual.empty')} /> : null}
      {list[0] ? <ListItem title={t('atual.week', { date: weekdayDate(list[0].week_start) })} icon="newspaper-outline" onPress={() => router.push({ pathname: '/enem/atualidades/[digestId]', params: { digestId: list[0]!.id } })} /> : null}
      {list.length > 1 ? (
        <Section title={t('atual.archive')}>
          {list.slice(1).map((d) => (
            <ListItem key={d.id} title={t('atual.week', { date: weekdayDate(d.week_start) })} onPress={() => router.push({ pathname: '/enem/atualidades/[digestId]', params: { digestId: d.id } })} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
