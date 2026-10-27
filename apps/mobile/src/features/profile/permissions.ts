import * as Notifications from 'expo-notifications';
import { getKv } from '../../lib/kv';
import { requestNotificationPermission } from '../../platform/notifications';
import { t } from '../../i18n';

type Confirm = { confirm: (o: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string }) => Promise<boolean> };

/**
 * mobile-app.md §5.3: POST_NOTIFICATIONS is asked in context, after the first upload, with our
 * own rationale first (S-SYS-02) — never at first launch, and only once.
 */
export async function askNotificationsAfterUpload(overlay: Confirm) {
  const kv = getKv();
  if (kv.getBoolean('asked_notifications')) return;
  const current = await Notifications.getPermissionsAsync().catch(() => null);
  if (current?.granted) return;
  kv.set('asked_notifications', true);
  const ok = await overlay.confirm({ title: t('perm.notifications'), message: t('perm.notifications_body'), confirmLabel: t('perm.allow'), cancelLabel: t('perm.deny') });
  if (ok) await requestNotificationPermission();
}
