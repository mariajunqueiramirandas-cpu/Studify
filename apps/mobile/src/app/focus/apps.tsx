import { useEffect, useState } from 'react';
import { Banner, EmptyState, Screen, SkeletonList, SwitchRow, TextField } from '../../components';
import { t } from '../../i18n';
import { focusBlocker } from '../../platform/focus';
import type { InstalledApp } from '../../platform/types';
import { useDb } from '../../db/DatabaseProvider';
import { setAppBlocked, useBlocklist } from '../../features/focus/blocklist';

/** WEL-02.1 app picker: launcher apps only; phone, SMS, clock, settings and Studify are never listed (WEL-02.4). */
export default function FocusApps() {
  const db = useDb();
  const blocked = useBlocklist().data ?? [];
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    void focusBlocker.installedApps().then((list) => {
      if (alive) setApps(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const shown = (apps ?? []).filter((a) => !q || a.label.toLowerCase().includes(q));


  return (
    <Screen title={t('focus.pick_apps')}>
      {/* WEL-02.5: the list of apps never leaves the phone. */}
      <Banner kind="neutral" icon="lock-closed-outline" message={t('focus.apps_private')} />
      <TextField label={t('global.search')} value={query} onChangeText={setQuery} />
      {apps === null ? <SkeletonList rows={6} height={48} /> : null}
      {apps !== null && apps.length === 0 ? <EmptyState icon="apps-outline" message={t('focus.apps_none')} /> : null}
      {shown.map((a) => (
        <SwitchRow key={a.packageName} label={a.label} value={blocked.includes(a.packageName)} onChange={(v) => setAppBlocked(db, a, v)} />
      ))}
    </Screen>
  );
}
