import { useMemo } from 'react';
import { View } from 'react-native';
import { Screen, Text, useOverlay } from '../../components';
import { RichCard } from '../../features/notifications/RichCard';
import { previewSamples } from '../../features/notifications/samples';
import { t } from '../../i18n';
import { requestNotificationPermission } from '../../platform/notifications';
import { richNotifier } from '../../platform/rich-notify';
import { space } from '../../theme';

/** Perfil → Notificações → Ver exemplos: every layout, sent to the shade on tap. */
export default function NotificationPreview() {
  const overlay = useOverlay();
  const samples = useMemo(() => previewSamples(), []);
  const send = async (i: number) => {
    const n = samples[i];
    if (!n) return;
    if (!richNotifier.native) {
      overlay.snack(t('notif.preview_unavailable'));
      return;
    }
    await requestNotificationPermission().catch(() => false);
    if (await richNotifier.show(n)) {
      overlay.snack(t('notif.preview_sent'));
      return;
    }
    // "Off" only when Android says so; anything else is a failure to post, with the reason for support.
    if (!richNotifier.capabilities().enabled) {
      overlay.snack(t('notif.disabled'));
      return;
    }
    overlay.snack(t('notif.preview_failed', { reason: richNotifier.lastError() ?? '' }).trim());
  };
  return (
    <Screen title={t('notif.preview_title')}>
      <Text variant="bodySmall" tone="secondary">
        {t('notif.preview_hint')}
      </Text>
      <View style={{ gap: space.md }}>
        {samples.map((n, i) => (
          <RichCard key={n.key} n={n} onPress={() => void send(i)} testID={`preview-${n.template}`} />
        ))}
      </View>
    </Screen>
  );
}
