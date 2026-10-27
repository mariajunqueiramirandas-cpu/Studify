// Tapping a push or local notification opens the screen in its `deep_link` (worker notify catalog, PLT-05).
// A cold start re-delivers the last response, so each one is opened once.
import { DEFAULT_ACTION_IDENTIFIER, addNotificationResponseReceivedListener, getLastNotificationResponseAsync, type NotificationResponse } from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { getKv } from '../lib/kv';

const OPENED_KEY = 'notif.lastOpened';

/** studify://… → an app path. Battles and duels live at the top level, not under the Turma. */
export function pathForDeepLink(link: string): string | null {
  if (!link.startsWith('studify://')) return null;
  const path = `/${link.slice('studify://'.length)}`;
  return path.replace(/^\/class\/[^/?]+\/(battle|duel)\/([^/?]+)/, '/$1/$2');
}

export function attachNotificationLinks(): () => void {
  const open = (response: NotificationResponse) => {
    if (response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;
    const link = (response.notification.request.content.data as { deep_link?: unknown } | undefined)?.deep_link;
    if (typeof link !== 'string') return;
    const key = `${response.notification.request.identifier}|${response.notification.date}`;
    if (getKv().getString(OPENED_KEY) === key) return;
    getKv().set(OPENED_KEY, key);
    const path = pathForDeepLink(link);
    if (path) router.push(path as Href);
  };
  const sub = addNotificationResponseReceivedListener(open);
  void getLastNotificationResponseAsync().then((last) => {
    if (last) open(last);
  });
  return () => sub.remove();
}
