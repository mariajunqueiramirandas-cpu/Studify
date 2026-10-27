// Everything notifications need while the student is signed in, mounted once by the root layout:
// - the push token of this install (and again when the permission is granted or FCM rotates it);
// - the rich local reminders, re-planned on start, after each sync, when the inputs change, when the app
//   comes back and every 30 minutes (mobile-app.md §5.2);
// - the ratings tapped on card notifications while the app was closed, recorded as reviews;
// - live progress of the student's jobs, mirrored into the Live Update (live-jobs.ts);
// - the Central de notificações badge, refreshed when a push arrives.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { useDb } from '../../db/DatabaseProvider';
import { useSyncStatus } from '../../db/sync';
import { onNotificationPermissionGranted } from '../../platform/notifications';
import { richNotifier } from '../../platform/rich-notify';
import { useSession } from '../auth/session';
import { usePerformanceWindows } from '../energy/api';
import { useMotivation } from '../motivation/api';
import { replayNotificationActions } from './actions';
import { useLiveJobs } from './live-jobs';
import { registerPushToken, watchPushToken } from './push-token';
import { syncReminders, type ReminderExtras } from './reminder-sync';

const RESYNC_MS = 30 * 60_000;
const DEBOUNCE_MS = 1500;

export function NotificationsRuntime() {
  const { userId, profile } = useSession();
  const db = useDb();
  const qc = useQueryClient();
  const motivation = useMotivation();
  const windows = usePerformanceWindows();
  const sync = useSyncStatus();
  useLiveJobs();

  const m = motivation.data;
  const extras = useMemo<ReminderExtras>(
    () => ({
      settings: profile?.settings ?? {},
      bestBuckets: windows.data?.best ?? [],
      streak: m ? { current: m.streak, shields: m.shields, todayMinutes: m.todayMinutes, goalMinutes: m.dailyGoal } : null,
    }),
    [profile?.settings, windows.data, m],
  );
  const extrasRef = useRef(extras);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resync = useCallback(() => {
    if (!userId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void syncReminders(db, userId, extrasRef.current);
    }, DEBOUNCE_MS);
  }, [db, userId]);

  const refreshInbox = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['inbox'] });
    void qc.invalidateQueries({ queryKey: ['inboxUnread'] });
  }, [qc]);

  // Push token.
  useEffect(() => {
    if (!userId) return undefined;
    void registerPushToken(userId);
    const stopWatch = watchPushToken(userId);
    const stopGranted = onNotificationPermissionGranted(() => {
      void registerPushToken(userId);
      resync();
    });
    return () => {
      stopWatch();
      stopGranted();
    };
  }, [userId, resync]);

  // Reminders follow their inputs: settings, energy windows, streak, and every sync (cards due change).
  useEffect(() => {
    extrasRef.current = extras;
    resync();
  }, [resync, extras, sync.lastSyncAt]);

  // Foreground, periodic re-plan and the actions queued by the native module.
  useEffect(() => {
    if (!userId) return undefined;
    const replay = () => void replayNotificationActions(db).then((n) => (n > 0 ? resync() : undefined));
    replay();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      replay();
      resync();
      refreshInbox();
      void qc.invalidateQueries({ queryKey: ['liveJobs'] });
    });
    const interval = setInterval(resync, RESYNC_MS);
    const stopEvents = richNotifier.onEvent((e) => {
      if (e.type === 'action') replay();
      if (e.type === 'received') refreshInbox();
    });
    return () => {
      sub.remove();
      clearInterval(interval);
      stopEvents();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [db, userId, qc, resync, refreshInbox]);

  return null;
}
