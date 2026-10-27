// XP for Phase 5 events the device sees first (spec 13 §8.1): a defeated boss and completed focus cycles. The
// amount comes from the shared rules (xpFor); sync-push clamps it and (user, ref, feature) is awarded once.
import { isInQuietHours, xpFor, type XpEvent } from '@studify/shared';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../../db/client';
import { enqueueOutbox } from '../../db/outbox';
import { studyPreferences } from '../../db/schema';
import { studyDateOf } from '../../lib/dates';

const NO_CAPS = { dailyGoalXpAwarded: false, noteXpToday: 0, podcastsToday: 0 };

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function awardXp(db: AppDb, userId: string, event: XpEvent, ref: { type: string; id: string; feature: string }, at = new Date()): number {
  const amount = xpFor(event, NO_CAPS);
  if (amount <= 0) return 0;
  const prefs = db.select().from(studyPreferences).where(eq(studyPreferences.userId, userId)).get();
  const quiet = isInQuietHours(hhmm(at), prefs?.quietStart ?? '22:00', prefs?.quietEnd ?? '07:00');
  enqueueOutbox(db, {
    kind: 'xp_event',
    payload: { amount, source_feature: ref.feature, ref_type: ref.type, ref_id: ref.id, occurred_at: at.toISOString(), local_date: studyDateOf(at), in_quiet_hours: quiet },
  });
  return amount;
}
