// After account-reset: the server data is gone, so this phone drops what it kept of it (local database, outbox,
// caches, persisted stores, scheduled reminders, a running focus session) and restarts the app. The login session
// and the device id stay, so the student lands in the onboarding signed in.
import * as Updates from 'expo-updates';
import { DevSettings } from 'react-native';
import { queryClient } from '../../api/queryClient';
import { isSessionKey } from '../../api/secure-session-storage';
import { wipeAppDatabase } from '../../db/client';
import { DEVICE_ID_KEY } from '../../lib/device';
import { clearKv, getKv } from '../../lib/kv';
import { focusBlocker } from '../../platform/focus';
import { richNotifier } from '../../platform/rich-notify';

/** Set by the reset, read once after the restart: the auth gate sends the student into the onboarding again. */
const RESTART_ONBOARDING_KEY = 'onboarding.restart';

export function takeOnboardingRestart(): boolean {
  try {
    const pending = getKv().getString(RESTART_ONBOARDING_KEY) === '1';
    if (pending) getKv().remove(RESTART_ONBOARDING_KEY);
    return pending;
  } catch {
    return false;
  }
}

export async function wipeLocalDataAndRestart(): Promise<void> {
  focusBlocker.stop();
  await richNotifier.cancelScheduled('').catch(() => 0);
  await wipeAppDatabase();
  queryClient.clear();
  clearKv((key) => key === DEVICE_ID_KEY || isSessionKey(key));
  getKv().set(RESTART_ONBOARDING_KEY, '1');
  // A restart also resets every in-memory store (focus run, quiz runner, UI settings).
  try {
    await Updates.reloadAsync();
  } catch {
    DevSettings.reload();
  }
}
