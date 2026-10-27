// Re-syncs the calendar when the app comes to the front, at most every 6 hours (GOL-09.3: events follow replans).
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useDb } from '../../db/DatabaseProvider';
import { logger } from '../../lib/logger';
import { useSession } from '../auth/session';
import { usePerformanceWindows } from '../energy/api';
import { calendarSettings, runCalendarSync } from './sync';

const EVERY_MS = 6 * 3600_000;

export function useCalendarAutoSync(): void {
  const db = useDb();
  const { userId } = useSession();
  const best = usePerformanceWindows().data?.best;
  useEffect(() => {
    if (!userId) return;
    let running = false;
    const maybeSync = () => {
      const s = calendarSettings();
      if (!s.enabled || running || (s.lastSync && Date.now() - s.lastSync < EVERY_MS)) return;
      running = true;
      void runCalendarSync(db, userId, best ?? [])
        .catch((e: unknown) => logger.warn('calendar.sync_failed', { error: String(e) }))
        .finally(() => {
          running = false;
        });
    };
    maybeSync();
    const sub = AppState.addEventListener('change', (st) => st === 'active' && maybeSync());
    return () => sub.remove();
  }, [db, userId, best]);
}
