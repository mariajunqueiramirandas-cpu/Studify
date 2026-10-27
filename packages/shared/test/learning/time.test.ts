import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ZONE,
  addDays,
  daysBetween,
  daysUntil,
  endOfStudyDay,
  startOfStudyDay,
  studyDay,
  tzOffsetMs,
} from '../../src/learning/time.ts';

// São Paulo is UTC-3 year round (no DST since 2019): local 04:00 is 07:00Z.
const sp = (iso: string): Date => new Date(iso);

describe('study day boundary at 04:00 (MEM-02.13, §0.2)', () => {
  it('activity at 01:30 local belongs to the previous study day', () => {
    expect(studyDay(sp('2026-10-27T04:30:00Z'), DEFAULT_TIME_ZONE)).toBe('2026-10-26');
  });

  it('03:59 local is still the previous day and 04:00 local starts the new one', () => {
    expect(studyDay(sp('2026-10-28T06:59:59Z'), DEFAULT_TIME_ZONE)).toBe('2026-10-27');
    expect(studyDay(sp('2026-10-28T07:00:00Z'), DEFAULT_TIME_ZONE)).toBe('2026-10-28');
  });

  it('startOfStudyDay and endOfStudyDay bracket the day at 04:00 local', () => {
    expect(startOfStudyDay('2026-10-27').toISOString()).toBe('2026-10-27T07:00:00.000Z');
    expect(endOfStudyDay('2026-10-27').toISOString()).toBe('2026-10-28T06:59:59.999Z');
  });

  it('uses the given time zone (UTC has no offset)', () => {
    expect(studyDay(new Date('2026-10-27T03:30:00Z'), 'UTC')).toBe('2026-10-26');
    expect(studyDay(new Date('2026-10-27T04:00:00Z'), 'UTC')).toBe('2026-10-27');
  });
});

describe('time zone offsets', () => {
  it('America/Sao_Paulo is UTC-3', () => {
    expect(tzOffsetMs('America/Sao_Paulo', sp('2026-10-27T12:00:00Z'))).toBe(-3 * 3_600_000);
  });

  it('rejects an unknown time zone', () => {
    expect(() => studyDay(sp('2026-10-27T12:00:00Z'), 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('calendar arithmetic', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('daysBetween is signed whole days', () => {
    expect(daysBetween('2026-10-27', '2026-11-05')).toBe(9);
    expect(daysBetween('2026-11-05', '2026-10-27')).toBe(-9);
  });

  it('daysUntil counts study days, not 24-hour periods', () => {
    const now = sp('2026-10-27T12:00:00Z'); // 09:00 local on the 27th
    expect(daysUntil(sp('2026-11-05T12:00:00Z'), now)).toBe(9);
  });
});
