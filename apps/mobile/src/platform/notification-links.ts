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

/**
 * A tap on a native rich notification opens its deep link with `notif=<key>` appended (studify-notify
 * RichRenderer.openIntent). Returns the app path without that parameter and the key, or null for any other
 * link, which is left alone.
 */
export function parseNotificationTap(url: string): { path: string; key: string } | null {
  const q = url.indexOf('?');
  if (q < 0) return null;
  const params = url.slice(q + 1).split('&');
  const hit = params.find((p) => p.startsWith('notif='));
  if (!hit) return null;
  let key: string;
  try {
    key = decodeURIComponent(hit.slice('notif='.length).replace(/\+/g, ' '));
  } catch {
    return null;
  }
  const rest = params.filter((p) => p !== hit);
  const base = url.slice(0, q);
  const link = base.startsWith('studify://') ? base : `studify://${base.replace(/^\/+/, '')}`;
  const path = pathForDeepLink(link) ?? '/';
  return { path: rest.length ? `${path}?${rest.join('&')}` : path, key };
}

/** `onOpened` gets the rich key of a plain push that was tapped, so its inbox row can be marked read. */
export function attachNotificationLinks(onOpened?: (richKey: string) => void): () => void {
  const open = (response: NotificationResponse) => {
    if (response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;
    const data = response.notification.request.content.data as { deep_link?: unknown; rich?: { key?: unknown }; rich_key?: unknown } | undefined;
    const link = data?.deep_link;
    if (typeof link !== 'string') return;
    const key = `${response.notification.request.identifier}|${response.notification.date}`;
    if (getKv().getString(OPENED_KEY) === key) return;
    getKv().set(OPENED_KEY, key);
    const richKey = data?.rich?.key ?? data?.rich_key;
    if (typeof richKey === 'string') onOpened?.(richKey);
    const path = pathForDeepLink(link);
    if (path) router.push(path as Href);
  };
  const sub = addNotificationResponseReceivedListener(open);
  void getLastNotificationResponseAsync().then((last) => {
    if (last) open(last);
  });
  return () => sub.remove();
}
