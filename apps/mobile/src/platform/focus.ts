// WEL-01/02 focus service seam (mobile-app.md §19). The local Expo module (modules/studify-focus) runs the
// countdown notification, the end-of-phase alert, Não perturbe and the Bloqueio overlay on Android. Without it
// (Expo Go, tests, other platforms) everything here is a no-op and Modo foco works as soft focus (WEL-02.6).
import { requireOptionalNativeModule, type EventSubscription } from 'expo';
import { Platform } from 'react-native';
import type { FocusBlocker, FocusNativeAction, FocusPermissionState, InstalledApp } from './types';

interface NativeFocus {
  start(configJson: string): void;
  stop(): void;
  isRunning(): boolean;
  consumeActions(): { action: string; at: number }[];
  blockedAttempts(): number;
  isInteractive(): boolean;
  permissions(): FocusPermissionState;
  openUsageAccessSettings(): void;
  openOverlaySettings(): void;
  openDndSettings(): void;
  getInstalledApps(): Promise<InstalledApp[]>;
  addListener(event: 'onFocusAction', listener: () => void): EventSubscription;
}

const ACTIONS: readonly FocusNativeAction[] = ['pause', 'resume', 'skip', 'stop'];

function load(): NativeFocus | null {
  if (Platform.OS !== 'android') return null;
  try {
    return requireOptionalNativeModule<NativeFocus>('StudifyFocus');
  } catch {
    return null;
  }
}

const native = load();
const NONE: FocusPermissionState = { usage: false, overlay: false, dnd: false };

/** Never throws: a native failure leaves the session running as soft focus. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const focusBlocker: FocusBlocker = {
  available: !!native,
  start: (state) => safe(() => native?.start(JSON.stringify(state)), undefined),
  stop: () => safe(() => native?.stop(), undefined),
  isRunning: () => safe(() => native?.isRunning() ?? false, false),
  consumeActions: () =>
    safe(() => (native?.consumeActions() ?? []).filter((a): a is { action: FocusNativeAction; at: number } => ACTIONS.includes(a.action as FocusNativeAction)), []),
  blockedAttempts: () => safe(() => native?.blockedAttempts() ?? 0, 0),
  isInteractive: () => safe(() => (native ? native.isInteractive() : null), null),
  permissions: () => safe(() => native?.permissions() ?? NONE, NONE),
  openUsageAccessSettings: () => safe(() => native?.openUsageAccessSettings(), undefined),
  openOverlaySettings: () => safe(() => native?.openOverlaySettings(), undefined),
  openDndSettings: () => safe(() => native?.openDndSettings(), undefined),
  installedApps: async () => (native ? native.getInstalledApps().catch(() => []) : []),
  onAction: (listener) => {
    if (!native) return () => undefined;
    const sub = safe(() => native.addListener('onFocusAction', listener), null);
    return () => sub?.remove();
  },
};
