// Continuous use of the app, for the burnout guard's long-session and late-night heuristics (spec 13 §8.10). A
// break of 5 minutes or more starts a new stretch. Device only; nothing here is uploaded.
import { BURNOUT } from '@studify/shared';
import { AppState, type AppStateStatus } from 'react-native';
import { getKv } from '../../lib/kv';

const KEY = 'wellbeing.activity';

interface Activity {
  /** Start of the current stretch of use. */
  segmentStart: number | null;
  /** Last moment the app was seen in the foreground. */
  lastActive: number | null;
}

function read(): Activity {
  try {
    return { segmentStart: null, lastActive: null, ...(JSON.parse(getKv().getString(KEY) ?? '{}') as Partial<Activity>) };
  } catch {
    return { segmentStart: null, lastActive: null };
  }
}

function write(a: Activity): void {
  getKv().set(KEY, JSON.stringify(a));
}

const BREAK_MS = BURNOUT.breakResetMin * 60_000;

export function noteActive(now = Date.now()): void {
  const a = read();
  const fresh = a.lastActive === null || now - a.lastActive >= BREAK_MS || a.segmentStart === null;
  write({ segmentStart: fresh ? now : a.segmentStart, lastActive: now });
}

/** Minutes of use since the last break of ≥ 5 min (0 when the app has been away that long). */
export function continuousMinutes(now = Date.now()): number {
  const a = read();
  if (a.segmentStart === null || a.lastActive === null) return 0;
  const away = AppState.currentState === 'active' ? 0 : now - a.lastActive;
  if (away >= BREAK_MS) return 0;
  return Math.max(0, Math.floor((now - a.segmentStart) / 60_000));
}

/** Starts tracking; returns the unsubscribe function. */
export function startActivityTracking(): () => void {
  if (AppState.currentState === 'active') noteActive();
  // Keep `lastActive` fresh while the app stays open.
  const timer = setInterval(() => {
    if (AppState.currentState === 'active') noteActive();
  }, 60_000);
  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') noteActive();
    else {
      const a = read();
      write({ ...a, lastActive: Date.now() });
    }
  });
  return () => {
    clearInterval(timer);
    sub.remove();
  };
}
