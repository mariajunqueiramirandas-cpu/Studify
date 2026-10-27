// Replays what the student did on notifications while the app was closed (api.md §9.1): "Errei" and
// "Acertei" on a card notification become reviews with the time they were tapped, through the same
// recordReview as the review screen and the widget (MEM-02, offline-first).
import type { Grade } from 'ts-fsrs';
import type { AppDb } from '../../db/client';
import { recordReview } from '../../db/hooks/review';
import { logger } from '../../lib/logger';
import { richNotifier } from '../../platform/rich-notify';

export async function replayNotificationActions(db: AppDb): Promise<number> {
  let recorded = 0;
  for (const a of richNotifier.consumeActions()) {
    // The preview gallery's sample card is not a real card.
    if ((a.kind !== 'rate_again' && a.kind !== 'rate_good') || !a.cardId || a.cardId === 'preview') continue;
    try {
      await recordReview(db, { cardId: a.cardId, rating: (a.kind === 'rate_again' ? 1 : 3) as Grade, source: 'notification', now: new Date(a.at) });
      recorded++;
    } catch (e) {
      // The card may be gone or already reviewed on another device; the queue moves on.
      logger.warn('notification.rating_failed', { error: String(e) });
    }
  }
  return recorded;
}
