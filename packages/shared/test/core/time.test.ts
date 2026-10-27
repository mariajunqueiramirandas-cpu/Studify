import { describe, expect, it } from 'vitest';
import {
  addDays,
  aiBudgetDayOf,
  clampLwwTimestamp,
  clampReviewedAt,
  daysBetween,
  isInQuietHours,
  isLocalDate,
  isValidTimeZone,
  localDateOf,
  localTimeOf,
  startOfAiBudgetDay,
  startOfStudyDay,
  studyDayBounds,
  studyDayOf,
  wallClockOf,
} from '../../src/core/time.ts';

const SP = 'America/Sao_Paulo'; // UTC-03:00, no DST since 2019
const NY = 'America/New_York'; // DST: 2026-03-08 spring forward, 2026-11-01 fall back

describe('study day boundary at 04:00 (São Paulo, DST-free)', () => {
  it('01:30 local belongs to the previous study day', () => {
    expect(studyDayOf(new Date('2026-10-27T04:30:00Z'), SP)).toBe('2026-10-26');
  });

  it('03:59:59.999 is still the previous day, 04:00:00 starts the new one', () => {
    expect(studyDayOf(new Date('2026-10-27T06:59:59.999Z'), SP)).toBe('2026-10-26');
    expect(studyDayOf(new Date('2026-10-27T07:00:00.000Z'), SP)).toBe('2026-10-27');
  });

  it('startOfStudyDay is 04:00 local (07:00Z) and round-trips', () => {
    const start = startOfStudyDay('2026-10-27', SP);
    expect(start.toISOString()).toBe('2026-10-27T07:00:00.000Z');
    expect(studyDayOf(start, SP)).toBe('2026-10-27');
    expect(studyDayOf(new Date(start.getTime() - 1), SP)).toBe('2026-10-26');
  });

  it('study day bounds are exactly 24 hours in a DST-free zone', () => {
    const { start, end } = studyDayBounds('2026-10-27', SP);
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('honours a custom rollover hour from study_preferences', () => {
    // rollover 0 means midnight: 01:30 belongs to the same calendar day
    expect(studyDayOf(new Date('2026-10-27T04:30:00Z'), SP, 0)).toBe('2026-10-27');
  });

  it('rejects an out-of-range rollover hour', () => {
    expect(() => studyDayOf(new Date(0), SP, 24)).toThrow(RangeError);
  });
});

describe('study day boundary in a DST zone (America/New_York)', () => {
  it('spring forward: 2026-03-08 starts at 04:00 EDT (08:00Z); the study day is 23 hours long', () => {
    expect(startOfStudyDay('2026-03-08', NY).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(studyDayOf(new Date('2026-03-08T07:59:00Z'), NY)).toBe('2026-03-07'); // 03:59 EDT
    expect(studyDayOf(new Date('2026-03-08T08:00:00Z'), NY)).toBe('2026-03-08'); // 04:00 EDT
    expect(studyDayOf(new Date('2026-03-08T06:30:00Z'), NY)).toBe('2026-03-07'); // 01:30 EST
    const { start, end } = studyDayBounds('2026-03-07', NY);
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });

  it('fall back: 2026-11-01 starts at 04:00 EST (09:00Z) and both 01:30s belong to 10-31', () => {
    expect(startOfStudyDay('2026-11-01', NY).toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(studyDayOf(new Date('2026-11-01T05:30:00Z'), NY)).toBe('2026-10-31'); // 01:30 EDT
    expect(studyDayOf(new Date('2026-11-01T06:30:00Z'), NY)).toBe('2026-10-31'); // 01:30 EST
    expect(studyDayOf(new Date('2026-11-01T08:59:00Z'), NY)).toBe('2026-10-31'); // 03:59 EST
    expect(studyDayOf(new Date('2026-11-01T09:00:00Z'), NY)).toBe('2026-11-01'); // 04:00 EST
  });
});

describe('AI budget day resets at local midnight', () => {
  it('midnight in São Paulo is 03:00Z', () => {
    expect(startOfAiBudgetDay('2026-10-27', SP).toISOString()).toBe('2026-10-27T03:00:00.000Z');
    expect(aiBudgetDayOf(new Date('2026-10-27T02:59:59Z'), SP)).toBe('2026-10-26');
    expect(aiBudgetDayOf(new Date('2026-10-27T03:00:00Z'), SP)).toBe('2026-10-27');
  });

  it('budget day differs from study day between 00:00 and 04:00', () => {
    const instant = new Date('2026-10-27T05:00:00Z'); // 02:00 local
    expect(aiBudgetDayOf(instant, SP)).toBe('2026-10-27');
    expect(studyDayOf(instant, SP)).toBe('2026-10-26');
  });
});

describe('calendar helpers', () => {
  it('wallClockOf and localTimeOf read the zone, not UTC', () => {
    const w = wallClockOf(new Date('2026-10-27T07:00:00Z'), SP);
    expect(w).toEqual({ date: '2026-10-27', hour: 4, minute: 0, second: 0 });
    expect(localTimeOf(new Date('2026-10-27T07:00:00Z'), SP)).toBe('04:00');
    expect(localDateOf(new Date('2026-10-27T02:00:00Z'), SP)).toBe('2026-10-26');
  });

  it('addDays crosses month, year and leap-year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-27', -1)).toBe('2026-10-26');
  });

  it('isLocalDate rejects impossible dates', () => {
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-1-05')).toBe(false);
    expect(isLocalDate(20261027)).toBe(false);
  });

  it('daysBetween counts whole civil days', () => {
    expect(daysBetween('2026-10-01', '2026-10-27')).toBe(26);
    expect(daysBetween('2026-10-27', '2026-10-01')).toBe(-26);
  });

  it('isValidTimeZone recognises IANA names only', () => {
    expect(isValidTimeZone(SP)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('quiet hours (PLT-05.3, default 22:00–07:00)', () => {
  it('wraps midnight', () => {
    expect(isInQuietHours('23:00', '22:00', '07:00')).toBe(true);
    expect(isInQuietHours('06:59', '22:00', '07:00')).toBe(true);
    expect(isInQuietHours('07:00', '22:00', '07:00')).toBe(false);
    expect(isInQuietHours('12:00', '22:00', '07:00')).toBe(false);
  });

  it('a zero-length window is never quiet; malformed times throw', () => {
    expect(isInQuietHours('12:00', '08:00', '08:00')).toBe(false);
    expect(() => isInQuietHours('25:00', '22:00', '07:00')).toThrow(RangeError);
  });
});

describe('clock clamping (ADR 0007 §6, mobile-app §4.3)', () => {
  const server = Date.UTC(2026, 9, 27, 12);
  const min = 60_000;

  it('keeps past reviews (offline) untouched', () => {
    expect(clampReviewedAt(server - 3 * 24 * 3600 * 1000, server)).toEqual({
      reviewedAtMs: server - 3 * 24 * 3600 * 1000,
      clockSkew: false,
    });
  });

  it('replaces reviews more than 5 min in the future with receipt time and flags skew', () => {
    expect(clampReviewedAt(server + 10 * min, server)).toEqual({ reviewedAtMs: server, clockSkew: true });
    expect(clampReviewedAt(server + 2 * min, server)).toEqual({ reviewedAtMs: server + 2 * min, clockSkew: false });
  });

  it('clamps LWW timestamps into the ±5 min window', () => {
    expect(clampLwwTimestamp(server + 30 * min, server)).toBe(server + 5 * min);
    expect(clampLwwTimestamp(server - 30 * min, server)).toBe(server - 5 * min);
    expect(clampLwwTimestamp(server, server)).toBe(server);
  });
});
