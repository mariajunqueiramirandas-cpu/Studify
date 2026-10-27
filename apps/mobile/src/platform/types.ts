// Platform seams (mobile-app.md §19). Android-only capabilities sit behind these interfaces; the
// no-op implementations on other platforms keep the rest of the app unchanged.
import type { ReminderCandidate, ScheduleResult } from './notification-policy';

export interface ReviewWidgetController {
  /** Re-renders the home-screen widget from the local queue. No-op where widgets are unsupported. */
  refresh(): Promise<void>;
}

export interface NotificationActionsController {
  /** Registers the review notification categories (reveal, rate). */
  registerCategories(): Promise<void>;
  /** Routes notification action taps to the review code path. Returns the unsubscribe function. */
  attach(): () => void;
}

export interface LocalReminderScheduler {
  ensureChannels(): Promise<void>;
  schedule(candidates: ReminderCandidate[]): Promise<ScheduleResult>;
  requestPermission(): Promise<boolean>;
}
