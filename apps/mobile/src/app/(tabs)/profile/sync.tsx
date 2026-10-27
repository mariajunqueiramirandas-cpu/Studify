import { Banner, Button, Screen, Text } from '../../../components';
import { retryStuckSync, syncNow, useSyncStatus } from '../../../db/sync';
import { formatAgo } from '../../../lib/format';
import { t } from '../../../i18n';

/** S-PERF-08 Sincronização: pending items, last sync, retry (PLT-07, mobile-app.md §4.3 rule 7). */
export default function SyncScreen() {
  const s = useSyncStatus();
  return (
    <Screen title={t('sync.title')}>
      {s.pending === 0 ? <Banner kind="success" message={t('sync.all_synced')} /> : <Banner kind="info" message={t('sync.pending', { n: s.pending })} />}
      {s.stuck > 0 ? <Banner kind="warning" message={t('sync.stuck', { n: s.stuck })} action={{ label: t('global.retry'), onPress: () => void retryStuckSync() }} /> : null}
      <Text tone="secondary">{s.lastSyncAt ? t('sync.last_sync', { when: formatAgo(new Date(s.lastSyncAt)) }) : t('sync.never')}</Text>
      <Button label={s.syncing ? t('sync.syncing') : t('sync.sync_now')} loading={s.syncing} onPress={() => void syncNow()} />
    </Screen>
  );
}
