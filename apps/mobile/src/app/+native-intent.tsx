// Links from outside the app pass through here first (expo-router native intents). A tap on a rich
// notification carries its key: the inbox row is marked read and the notification cleared, and the
// student lands on the screen itself. Everything else goes through unchanged.
import { markReadByKey } from '../features/notifications/inbox';
import { parseNotificationTap } from '../platform/notification-links';
import { richNotifier } from '../platform/rich-notify';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const tap = parseNotificationTap(path);
    if (!tap) return path;
    richNotifier.cancel(tap.key);
    void markReadByKey(tap.key);
    return tap.path;
  } catch {
    return path;
  }
}
