// Time on a wait the student can see (GenerationStatus): how long it has been running and how long is left.
import { useEffect, useState } from 'react';
import { t } from '../../i18n';

const toMs = (at: number | string | null | undefined): number | null => {
  if (at === null || at === undefined) return null;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Whole seconds since `startedAt` (a timestamp or an ISO date), ticking every second while `active`. Without a start
 * the count begins when the hook mounts, so a wait always shows how long the student has been on it.
 */
export function useElapsed(startedAt?: number | string | null, active = true): number {
  const [mountedAt] = useState(() => Date.now());
  const start = toMs(startedAt) ?? mountedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** "8 s", "1 min 20 s", "4 min": short enough for a caption line. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('wait.seconds', { n: s });
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 3 || rest === 0) return t('wait.minutes', { n: rest >= 30 && m >= 3 ? m + 1 : m });
  return t('wait.minutes_seconds', { m, s: rest });
}
