import { router } from 'expo-router';
import { Card, EmptyState, Screen, SkeletonList, Text } from '../../components';
import { shortDate } from '../../features/common/format';
import { useRetrospectives } from '../../features/retro/api';
import { t } from '../../i18n';

/** Retrospectivas (MOT-04): every recap generated so far, newest first. Deep link: studify://retro. */
export default function RetroList() {
  const list = useRetrospectives();
  return (
    <Screen title={t('retro.title')}>
      {list.isLoading ? <SkeletonList rows={3} /> : null}
      {list.data && list.data.length === 0 ? <EmptyState icon="sparkles-outline" message={t('retro.empty')} /> : null}
      {(list.data ?? []).map((r) => (
        <Card key={r.id} tone={r.seen_at ? 'default' : 'soft'} onPress={() => router.push({ pathname: '/retro/[retroId]', params: { retroId: r.id } })}>
          <Text variant="caption" tone="secondary">
            {`${t(`retro.period.${r.period_type}`)} · ${shortDate(r.period_start)} – ${shortDate(r.period_end)}`}
          </Text>
          <Text variant="heading">{r.title}</Text>
          {r.subtitle ? <Text tone="secondary">{r.subtitle}</Text> : null}
          {!r.seen_at ? (
            <Text variant="label" tone="accent">
              {t('retro.new')}
            </Text>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
