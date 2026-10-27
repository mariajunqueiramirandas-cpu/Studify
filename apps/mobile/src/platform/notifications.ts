// Local notifications (mobile-app.md §5): Android channels (§5.1), in-context permission, and
// scheduling through the reminder policy. Other platforms get no-ops.
import {
  AndroidImportance,
  SchedulableTriggerInputTypes,
  cancelScheduledNotificationAsync,
  getAllScheduledNotificationsAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
} from 'expo-notifications';
import { Platform } from 'react-native';
import { planReminders, type DroppedReminder, type QuietHours, type ReminderCandidate, type ScheduleResult } from './notification-policy';
import { REVIEW_RATE_CATEGORY } from './notification-actions';

export const CHANNELS = [
  { id: 'reviews', name: 'Revisões', importance: AndroidImportance.DEFAULT },
  { id: 'plan', name: 'Plano de estudos', importance: AndroidImportance.DEFAULT },
  { id: 'class', name: 'Turma', importance: AndroidImportance.DEFAULT },
  { id: 'processing', name: 'Processamento', importance: AndroidImportance.LOW },
] as const;

const PREFIX = 'studify:';

/** Creates the four Android channels (idempotent). Call on app start. */
export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of CHANNELS) {
    await setNotificationChannelAsync(channel.id, { name: channel.name, importance: channel.importance });
  }
}

/**
 * Asks for POST_NOTIFICATIONS. Call in context (after the first upload, or when the user turns on
 * reminders), never at first launch (mobile-app.md §5.3).
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const current = await getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const requested = await requestPermissionsAsync();
  return requested.granted;
}

/**
 * Replaces all Studify reminders with `candidates` after applying the policy (quiet hours, daily
 * cap). Call after every sync and on app start, as mobile-app.md §5.2 requires.
 */
export async function scheduleLocalReminders(
  candidates: ReminderCandidate[],
  options: { now?: Date; quiet?: QuietHours } = {},
): Promise<ScheduleResult> {
  if (Platform.OS !== 'android') return { scheduled: 0, dropped: [] };

  const plan = planReminders(candidates, options);
  const existing = await getAllScheduledNotificationsAsync();
  for (const request of existing) {
    if (request.identifier.startsWith(PREFIX)) {
      await cancelScheduledNotificationAsync(request.identifier);
    }
  }

  for (const candidate of plan.scheduled) {
    await scheduleNotificationAsync({
      identifier: `${PREFIX}${candidate.id}`,
      content: {
        title: candidate.title,
        body: candidate.body,
        data: {
          deep_link: candidate.deepLink ?? null,
          cardId: candidate.cardId ?? null,
        },
        categoryIdentifier: candidate.categoryIdentifier ?? (candidate.cardId ? REVIEW_RATE_CATEGORY : undefined),
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: candidate.at,
        channelId: candidate.channel,
      },
    });
  }

  const dropped: DroppedReminder[] = plan.dropped;
  return { scheduled: plan.scheduled.length, dropped };
}
