import { NumberStepper, Screen, Section, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { updateSettings } from '../../../features/profile/api';
import { t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

interface MemorySettings {
  desired_retention?: number;
  new_per_day?: number;
  max_reviews_per_day?: number;
}

/** S-PERF-06 Memória: Meta de lembrança, cartões novos por dia, máximo de revisões (MEM-02). */
export default function MemorySettingsScreen() {
  const { profile, refreshProfile } = useSession();
  const overlay = useOverlay();
  const memory = ((profile?.settings as { memory?: MemorySettings } | undefined)?.memory ?? {}) as MemorySettings;
  const save = (patch: MemorySettings) => void updateSettings({ memory: { ...memory, ...patch } }).then(refreshProfile).catch((e: unknown) => overlay.snack(messageFor(e)));
  return (
    <Screen title={t('memory.title')}>
      <Section>
        <NumberStepper label={t('memory.retention')} value={Math.round((memory.desired_retention ?? 0.9) * 100)} min={80} max={97} step={1} format={(v) => `${v}%`} onChange={(v) => save({ desired_retention: v / 100 })} />
        <Text variant="bodySmall" tone="secondary">
          {t('memory.retention_hint')}
        </Text>
        <NumberStepper label={t('memory.new_per_day')} value={memory.new_per_day ?? 20} min={0} max={100} step={5} onChange={(v) => save({ new_per_day: v })} />
        <NumberStepper label={t('memory.max_reviews')} value={memory.max_reviews_per_day ?? 200} min={20} max={1000} step={20} onChange={(v) => save({ max_reviews_per_day: v })} />
      </Section>
    </Screen>
  );
}
