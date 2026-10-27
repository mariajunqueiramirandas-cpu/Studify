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

export interface FocusPermissionState {
  /** UsageStats special access: needed to see which app is in front (WEL-02.2). */
  usage: boolean;
  /** "Sobrepor a outros apps": needed for the Bloqueio overlay (WEL-02.3). */
  overlay: boolean;
  /** Notification policy access: needed for Não perturbe (WEL-01.4). */
  dnd: boolean;
}

export interface InstalledApp {
  packageName: string;
  label: string;
}

/** What the native side needs to run the countdown, alerts, Não perturbe and blocking without the JS runtime. */
export interface FocusNativeState {
  sessionId: string;
  phases: { kind: 'focus' | 'break' | 'long_break'; ms: number }[];
  index: number;
  phaseEndsAt: number;
  paused: boolean;
  remainingMs: number;
  blocked: string[];
  dnd: boolean;
  openUrl: string;
  strings: Record<string, string>;
}

export type FocusNativeAction = 'pause' | 'resume' | 'skip' | 'stop';

/** WEL-01/02 (mobile-app.md §19 `FocusBlocker`): the Android focus service; a no-op elsewhere (soft focus only). */
export interface FocusBlocker {
  readonly available: boolean;
  start(state: FocusNativeState): void;
  stop(): void;
  isRunning(): boolean;
  /** Actions taken from the notification or the overlay since the last call, oldest first. */
  consumeActions(): { action: FocusNativeAction; at: number }[];
  blockedAttempts(): number;
  /** Screen on: leaving Studify now is an interruption. null when unknown (no native module). */
  isInteractive(): boolean | null;
  permissions(): FocusPermissionState;
  openUsageAccessSettings(): void;
  openOverlaySettings(): void;
  openDndSettings(): void;
  installedApps(): Promise<InstalledApp[]>;
  /** Called when the native side queued an action. Returns the unsubscribe function. */
  onAction(listener: () => void): () => void;
}

export interface RichNotifyCapabilities {
  sdk: number;
  enabled: boolean;
  /** Android 16+: running jobs show as promoted Live Updates (status bar chip, lock screen). */
  liveUpdates: boolean;
  /** The student allows Live Updates for Studify (Android 16 setting). */
  promoted: boolean;
}

export interface RichNotifyAction {
  kind: 'snooze' | 'rate_again' | 'rate_good';
  key: string;
  at: number;
  cardId: string | null;
}

/** Rich notifications (PLT-05, api.md §9.1): the Android module `studify-notify`, or plain notifications elsewhere. */
export interface RichNotifier {
  readonly native: boolean;
  show(payload: import('@studify/shared').RichNotification): Promise<boolean>;
  cancel(key: string): void;
  schedule(id: string, at: Date, payload: import('@studify/shared').RichNotification): Promise<boolean>;
  cancelScheduled(prefix: string): Promise<number>;
  scheduledIds(): string[];
  activeKeys(): string[];
  consumeActions(): RichNotifyAction[];
  capabilities(): RichNotifyCapabilities;
  openSettings(): void;
  /** Called when the native side showed a notification or queued an action. Returns the unsubscribe function. */
  onEvent(listener: (e: { type: 'shown' | 'received' | 'action'; key: string }) => void): () => void;
}
