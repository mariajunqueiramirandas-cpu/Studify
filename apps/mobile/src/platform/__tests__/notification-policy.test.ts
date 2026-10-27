/// <reference types="jest" />
import { isInQuietHours, planReminders, type ReminderCandidate } from '../notification-policy';

const at = (h: number, m = 0, day = 27) => new Date(2026, 9, day, h, m, 0);
const cand = (id: string, when: Date, requested = false): ReminderCandidate => ({
  id,
  channel: 'reviews',
  title: 't',
  body: 'b',
  at: when,
  requested,
});

describe('quiet hours (22:00–07:00 default)', () => {
  it('treats an overnight window correctly', () => {
    expect(isInQuietHours(at(23, 0))).toBe(true);
    expect(isInQuietHours(at(3, 0))).toBe(true);
    expect(isInQuietHours(at(7, 0))).toBe(false);
    expect(isInQuietHours(at(12, 0))).toBe(false);
  });

  it('handles a same-day window and an equal start/end', () => {
    expect(isInQuietHours(at(14, 0), { start: '13:00', end: '15:00' })).toBe(true);
    expect(isInQuietHours(at(16, 0), { start: '13:00', end: '15:00' })).toBe(false);
    expect(isInQuietHours(at(3, 0), { start: '00:00', end: '00:00' })).toBe(false);
  });
});

describe('planReminders', () => {
  const now = at(9, 0);

  it('drops past and quiet-hour reminders', () => {
    const plan = planReminders([cand('past', at(8)), cand('night', at(23)), cand('ok', at(18))], { now });
    expect(plan.scheduled.map((c) => c.id)).toEqual(['ok']);
    expect(plan.dropped).toEqual([
      { id: 'past', reason: 'past' },
      { id: 'night', reason: 'quiet_hours' },
    ]);
  });

  it('caps unrequested notifications at 3 per day; requested ones are not capped', () => {
    const many = [10, 11, 12, 13, 14].map((h) => cand(`u${h}`, at(h)));
    const requested = cand('r', at(15), true);
    const plan = planReminders([...many, requested], { now });
    expect(plan.scheduled.map((c) => c.id)).toEqual(['u10', 'u11', 'u12', 'r']);
    expect(plan.dropped.filter((d) => d.reason === 'daily_cap').map((d) => d.id)).toEqual(['u13', 'u14']);
  });

  it('counts the cap per local day', () => {
    const plan = planReminders(
      [cand('a', at(10, 0, 27)), cand('b', at(11, 0, 27)), cand('c', at(12, 0, 27)), cand('d', at(10, 0, 28))],
      { now: at(9, 0, 27) },
    );
    expect(plan.scheduled.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
