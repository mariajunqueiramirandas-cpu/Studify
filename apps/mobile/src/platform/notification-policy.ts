// Local reminder policy (mobile-app.md §5.3): quiet hours (default 22:00–07:00) and at most 3
// unrequested notifications per local day. Pure, so it is unit-tested.

export interface QuietHours {
  /** "HH:mm" local time. */
  start: string;
  /** "HH:mm" local time. */
  end: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: '22:00', end: '07:00' };
export const UNREQUESTED_DAILY_CAP = 3;

export type ReminderChannel = 'reviews' | 'plan' | 'class' | 'processing';

export interface ReminderCandidate {
  /** Stable id; the scheduled notification identifier is `studify:<id>`. */
  id: string;
  channel: ReminderChannel;
  title: string;
  body: string;
  at: Date;
  /** True when the user explicitly set this reminder (does not count toward the cap). */
  requested: boolean;
  /** `studify://…` deep link opened on tap. */
  deepLink?: string;
  /** Review notifications carry the card id for the answer actions. */
  cardId?: string;
  categoryIdentifier?: string;
}

export type DropReason = 'past' | 'quiet_hours' | 'daily_cap';

export interface DroppedReminder {
  id: string;
  reason: DropReason;
}

export interface ScheduleResult {
  scheduled: number;
  dropped: DroppedReminder[];
}

export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** True when `date` (local time) falls inside the quiet window. The window may cross midnight. */
export function isInQuietHours(date: Date, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  const now = date.getHours() * 60 + date.getMinutes();
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Decides which candidates to schedule. Chronological order; a candidate is dropped when it is in
 * the past, inside quiet hours, or (unrequested only) beyond the day's cap.
 */
export function planReminders(
  candidates: readonly ReminderCandidate[],
  options: { now?: Date; quiet?: QuietHours; cap?: number } = {},
): { scheduled: ReminderCandidate[]; dropped: DroppedReminder[] } {
  const now = options.now ?? new Date();
  const quiet = options.quiet ?? DEFAULT_QUIET_HOURS;
  const cap = options.cap ?? UNREQUESTED_DAILY_CAP;
  const scheduled: ReminderCandidate[] = [];
  const dropped: DroppedReminder[] = [];
  const unrequestedPerDay = new Map<string, number>();

  const ordered = [...candidates].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const candidate of ordered) {
    if (candidate.at.getTime() <= now.getTime()) {
      dropped.push({ id: candidate.id, reason: 'past' });
      continue;
    }
    if (isInQuietHours(candidate.at, quiet)) {
      dropped.push({ id: candidate.id, reason: 'quiet_hours' });
      continue;
    }
    if (!candidate.requested) {
      const key = dayKey(candidate.at);
      const used = unrequestedPerDay.get(key) ?? 0;
      if (used >= cap) {
        dropped.push({ id: candidate.id, reason: 'daily_cap' });
        continue;
      }
      unrequestedPerDay.set(key, used + 1);
    }
    scheduled.push(candidate);
  }
  return { scheduled, dropped };
}
