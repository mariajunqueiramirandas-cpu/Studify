import { describe, expect, it } from 'vitest';
import { newCardQuota, type NewCardQuotaInput } from '../../src/learning/index.ts';

const base: NewCardQuotaInput = {
  date: '2026-10-27',
  hasActivePlan: true,
  exams: [],
  learnMinutes: 60,
};

describe('new-card quota (§4)', () => {
  it('without an active plan, uses settings.new_per_day (default 20)', () => {
    expect(newCardQuota({ ...base, hasActivePlan: false }).total).toBe(20);
    expect(newCardQuota({ ...base, hasActivePlan: false, settingsNewPerDay: 12 }).total).toBe(12);
  });

  it('time-driven amount: floor(0.25 × learn minutes × 60 / 20), with 60 minutes → 45', () => {
    const q = newCardQuota(base);
    expect(q.planned).toBe(45);
    expect(q.total).toBe(45);
    expect(q.capped).toBe(false);
    expect(q.blockedBy).toBe('none');
  });

  it('content-driven floor: required = ceil(N_E / max(1, days_until − 1)) raises the total', () => {
    // Exam 6 days away: days allowed = 5, so 150 cards need 30 per day. With no learn minutes the floor wins.
    const q = newCardQuota({ ...base, learnMinutes: 0, exams: [{ examId: 'e', localDate: '2026-11-02', newCardsInScope: 150 }] });
    expect(q.required).toBe(30);
    expect(q.planned).toBe(0);
    expect(q.total).toBe(30);
  });

  it('is capped at 50 and reports capped when the required amount is above the cap', () => {
    // Exam 3 days away: days allowed = 2, so 200 cards need 100 per day.
    const q = newCardQuota({ ...base, exams: [{ examId: 'e', localDate: '2026-10-30', newCardsInScope: 200 }] });
    expect(q.required).toBe(100);
    expect(q.total).toBe(50);
    expect(q.capped).toBe(true);
  });

  it('blocks new cards on the eve (D_e − 1) and the exam day (D_e)', () => {
    const eve = newCardQuota({ ...base, exams: [{ examId: 'e', localDate: '2026-10-28', newCardsInScope: 10 }] });
    expect(eve.total).toBe(0);
    expect(eve.blockedBy).toBe('eve');
    const examDay = newCardQuota({ ...base, exams: [{ examId: 'e', localDate: '2026-10-27', newCardsInScope: 10 }] });
    expect(examDay.total).toBe(0);
    expect(examDay.blockedBy).toBe('eve');
  });

  it('recovery mode forces total = 0', () => {
    const q = newCardQuota({ ...base, recoveryMode: true });
    expect(q.total).toBe(0);
    expect(q.blockedBy).toBe('recovery');
  });

  it('future-load protection keeps the next 7 days at or below 50% of available minutes', () => {
    // Forecast already 25 min on day +1 with 60 available (limit 30). Each new card adds 1/6 min
    // (10 s review) on day +1, so the total must drop to 30 cards.
    const q = newCardQuota({
      ...base,
      futureLoad: {
        forecastMinutes: [25, 0, 0, 0, 0, 0, 0],
        availableMinutes: [60, 60, 60, 60, 60, 60, 60],
      },
    });
    expect(q.total).toBe(30);
    expect(q.blockedBy).toBe('future_load');
  });

  it('future-load protection does nothing when there is room', () => {
    const q = newCardQuota({
      ...base,
      futureLoad: { forecastMinutes: [0, 0, 0, 0, 0, 0, 0], availableMinutes: [60, 60, 60, 60, 60, 60, 60] },
    });
    expect(q.total).toBe(45);
    expect(q.blockedBy).toBe('none');
  });

  it('pro-rates the total by subject learn minutes (largest remainder)', () => {
    const q = newCardQuota({ ...base, subjectLearnMinutes: { math: 30, bio: 10 } });
    expect(q.total).toBe(45);
    expect(q.bySubject).toEqual({ bio: 11, math: 34 });
    expect(Object.values(q.bySubject).reduce((a, b) => a + b, 0)).toBe(45);
  });
});
