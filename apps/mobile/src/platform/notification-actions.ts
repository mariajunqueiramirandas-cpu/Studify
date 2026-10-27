// Answer-from-notification (mobile-app.md §6.2). A review notification shows one card with
// "Ver resposta"; tapping it replaces the notification with the answer and "Errei"/"Acertei".
// Both paths run the same `recordReview` as the screen and the widget. Actions do not open the app
// (`opensAppToForeground: false`). Spike: killed-process delivery, see the report.
import {
  dismissNotificationAsync,
  getLastNotificationResponseAsync,
  addNotificationResponseReceivedListener,
  scheduleNotificationAsync,
  setNotificationCategoryAsync,
  type NotificationResponse,
} from 'expo-notifications';
import { eq } from 'drizzle-orm';
import { Platform } from 'react-native';
import { ensureAppDatabase } from '../db/client';
import { recordReview } from '../db/hooks/review';
import { cards } from '../db/schema';
import { getKv } from '../lib/kv';
import { logger } from '../lib/logger';

export const REVIEW_REVEAL_CATEGORY = 'review-reveal';
export const REVIEW_RATE_CATEGORY = 'review-rate';

export const ACTION = {
  REVEAL: 'reveal',
  AGAIN: 'rate-again',
  GOOD: 'rate-good',
} as const;

const PREFIX = 'studify:';

export async function registerReviewCategories(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await setNotificationCategoryAsync(REVIEW_REVEAL_CATEGORY, [
    { identifier: ACTION.REVEAL, buttonTitle: 'Ver resposta', options: { opensAppToForeground: false } },
  ]);
  await setNotificationCategoryAsync(REVIEW_RATE_CATEGORY, [
    { identifier: ACTION.AGAIN, buttonTitle: 'Errei', options: { opensAppToForeground: false } },
    { identifier: ACTION.GOOD, buttonTitle: 'Acertei', options: { opensAppToForeground: false } },
  ]);
}

interface ReviewNotificationData {
  cardId?: string;
  answer?: string;
}

function dataOf(response: NotificationResponse): ReviewNotificationData {
  return (response.notification.request.content.data ?? {}) as ReviewNotificationData;
}

const HANDLED_KEY = 'notif.lastHandled';

/** The last response is re-delivered on every cold start; each one must run only once. */
function responseKey(response: NotificationResponse): string {
  return `${response.notification.request.identifier}|${response.notification.date}|${response.actionIdentifier}`;
}

function alreadyHandled(response: NotificationResponse): boolean {
  return getKv().getString(HANDLED_KEY) === responseKey(response);
}

function markHandled(response: NotificationResponse): void {
  getKv().set(HANDLED_KEY, responseKey(response));
}

/** Handles one notification action. Exported for tests and for the cold-start path. */
export async function handleNotificationResponse(response: NotificationResponse): Promise<void> {
  const { actionIdentifier } = response;
  const notificationId = response.notification.request.identifier;
  const data = dataOf(response);
  if (!data.cardId || alreadyHandled(response)) return;
  markHandled(response);

  if (actionIdentifier === ACTION.REVEAL) {
    const db = await ensureAppDatabase();
    const row = db.select({ back: cards.back }).from(cards).where(eq(cards.id, data.cardId)).get();
    // Same identifier: the notification is replaced by the answer and the rating actions.
    await scheduleNotificationAsync({
      identifier: notificationId,
      content: {
        title: 'Resposta',
        body: row?.back ?? '',
        data: { cardId: data.cardId },
        categoryIdentifier: REVIEW_RATE_CATEGORY,
      },
      trigger: null,
    });
    return;
  }

  if (actionIdentifier === ACTION.AGAIN || actionIdentifier === ACTION.GOOD) {
    const db = await ensureAppDatabase();
    const rating = actionIdentifier === ACTION.AGAIN ? 1 : 3;
    await recordReview(db, { cardId: data.cardId, rating, source: 'notification' });
    await dismissNotificationAsync(notificationId).catch(() => undefined);
    return;
  }
}

/**
 * Attaches the response listener and processes a response that launched the app from a killed
 * state. Returns the unsubscribe function. Call once from the root layout.
 */
export function attachNotificationActions(): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  const run = (response: NotificationResponse) => {
    if (!response.notification.request.identifier.startsWith(PREFIX)) return;
    handleNotificationResponse(response).catch((error: unknown) => {
      logger.error('notification action failed', { message: error instanceof Error ? error.message : String(error) });
    });
  };
  const subscription = addNotificationResponseReceivedListener(run);
  void getLastNotificationResponseAsync().then((last) => {
    if (last) run(last);
  });
  return () => subscription.remove();
}
