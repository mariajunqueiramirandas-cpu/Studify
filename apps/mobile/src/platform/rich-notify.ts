// Rich notifications seam (mobile-app.md §19). On Android the local module `studify-notify` draws the custom
// layouts, Live Updates and actions natively. Without it (Expo Go, tests) the same payloads become plain
// expo-notifications with their title and body, so callers never branch.
import type { RichNotification } from '@studify/shared';
import { requireOptionalNativeModule, type EventSubscription } from 'expo';
import {
  SchedulableTriggerInputTypes,
  cancelScheduledNotificationAsync,
  dismissNotificationAsync,
  getAllScheduledNotificationsAsync,
  scheduleNotificationAsync,
} from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import type { RichNotifier, RichNotifyAction, RichNotifyCapabilities } from './types';

interface NativeNotify {
  show(json: string): boolean;
  cancel(key: string): void;
  activeKeys(): string[];
  schedule(id: string, atMs: number, json: string): boolean;
  cancelScheduled(prefix: string): number;
  scheduledIds(): string[];
  consumeActions(): { kind: string; key: string; at: number; cardId: string | null }[];
  capabilities(): RichNotifyCapabilities;
  openSettings(): void;
  addListener(event: 'onNotifyEvent', listener: (e: { type: string; key: string }) => void): EventSubscription;
}

function load(): NativeNotify | null {
  if (Platform.OS !== 'android') return null;
  try {
    return requireOptionalNativeModule<NativeNotify>('StudifyNotify');
  } catch {
    return null;
  }
}

const native = load();
const PLAIN = 'studify-plain:';
const KINDS = new Set(['snooze', 'rate_again', 'rate_good']);
const NONE: RichNotifyCapabilities = { sdk: 0, enabled: false, liveUpdates: false, promoted: false };

function plainContent(p: RichNotification) {
  // Live progress has no plain equivalent worth a sound: it updates silently on the live channel.
  return { title: p.title, body: p.body, data: { deep_link: p.deep_link ?? null, rich_key: p.key } };
}

export const richNotifier: RichNotifier = {
  native: !!native,
  async show(p) {
    if (native) {
      try {
        return native.show(JSON.stringify(p));
      } catch {
        return false;
      }
    }
    if (Platform.OS !== 'android') return false;
    await scheduleNotificationAsync({ identifier: PLAIN + p.key, content: plainContent(p), trigger: { channelId: p.channel === 'live' ? 'processing' : p.channel } }).catch(() => undefined);
    return true;
  },
  cancel(key) {
    if (native) {
      try {
        native.cancel(key);
      } catch {
        // already gone
      }
      return;
    }
    void dismissNotificationAsync(PLAIN + key).catch(() => undefined);
  },
  async schedule(id, at, p) {
    if (native) {
      try {
        return native.schedule(id, at.getTime(), JSON.stringify(p));
      } catch {
        return false;
      }
    }
    if (Platform.OS !== 'android') return false;
    await scheduleNotificationAsync({
      identifier: PLAIN + id,
      content: plainContent(p),
      trigger: { type: SchedulableTriggerInputTypes.DATE, date: at, channelId: p.channel === 'live' ? 'processing' : p.channel },
    }).catch(() => undefined);
    return true;
  },
  async cancelScheduled(prefix) {
    if (native) {
      try {
        return native.cancelScheduled(prefix);
      } catch {
        return 0;
      }
    }
    const all = await getAllScheduledNotificationsAsync().catch(() => []);
    const mine = all.filter((r) => r.identifier.startsWith(PLAIN + prefix));
    for (const r of mine) await cancelScheduledNotificationAsync(r.identifier).catch(() => undefined);
    return mine.length;
  },
  scheduledIds() {
    try {
      return native?.scheduledIds() ?? [];
    } catch {
      return [];
    }
  },
  activeKeys() {
    try {
      return native?.activeKeys() ?? [];
    } catch {
      return [];
    }
  },
  consumeActions() {
    try {
      return (native?.consumeActions() ?? []).filter((a): a is RichNotifyAction => KINDS.has(a.kind));
    } catch {
      return [];
    }
  },
  capabilities() {
    try {
      return native?.capabilities() ?? NONE;
    } catch {
      return NONE;
    }
  },
  openSettings() {
    if (native) {
      try {
        native.openSettings();
        return;
      } catch {
        // fall through
      }
    }
    void Linking.openSettings();
  },
  onEvent(listener) {
    if (!native) return () => undefined;
    try {
      const sub = native.addListener('onNotifyEvent', (e) => {
        if (e.type === 'shown' || e.type === 'received' || e.type === 'action') listener({ type: e.type, key: e.key });
      });
      return () => sub.remove();
    } catch {
      return () => undefined;
    }
  },
};
