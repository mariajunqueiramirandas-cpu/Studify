import { useState } from 'react';
import { Button, ProgressBar, Screen, Section, SegmentedControl, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { formatBytes } from '../../../features/common/format';
import { updateSettings } from '../../../features/profile/api';
import { clearDownloads, downloadsSize } from '../../../features/subjects/files';
import { options, t } from '../../../i18n';

const QUOTAS = [250, 500, 1000, 2000] as const;

/** S-PERF-07 Armazenamento: offline downloads + quota (PLT-07, mobile-app.md §4.1). */
export default function Storage() {
  const { profile, refreshProfile } = useSession();
  const overlay = useOverlay();
  const [used, setUsed] = useState(downloadsSize());
  const quota = ((profile?.settings as { storage_quota_mb?: number } | undefined)?.storage_quota_mb ?? 500) as (typeof QUOTAS)[number];
  const labels = options('storage.quota_options');
  return (
    <Screen title={t('storage.title')}>
      <Section>
        <SegmentedControl<string>
          label={t('storage.quota')}
          value={String(quota)}
          onChange={(v) => void updateSettings({ storage_quota_mb: Number(v) }).then(refreshProfile)}
          options={QUOTAS.map((q, i) => ({ value: String(q), label: labels[i] ?? `${q} MB` }))}
        />
        <ProgressBar value={used / (quota * 1024 * 1024)} />
        <Text tone="secondary">{t('storage.used', { used: formatBytes(used), quota: labels[QUOTAS.indexOf(quota)] ?? '' })}</Text>
      </Section>
      <Button
        variant="secondary"
        label={t('storage.clear')}
        onPress={async () => {
          if (!(await overlay.confirm({ title: t('storage.clear'), message: t('storage.clear_confirm'), destructive: true }))) return;
          clearDownloads();
          setUsed(0);
        }}
      />
    </Screen>
  );
}
