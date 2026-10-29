import { describe, expect, it } from 'vitest';
import { localParts, minutesOfDay, nextLocalMidnight, quietWindowEnd, studyDayStart, zonedToInstant } from '../../src/framework/timeutil.ts';

const TZ = 'America/Sao_Paulo'; // UTC-3, no DST since 2019

describe('zonedToInstant', () => {
  it('converts a wall-clock time in Sao Paulo to UTC', () => {
    expect(zonedToInstant(2026, 10, 27, 22, 0, TZ).toISOString()).toBe('2026-10-28T01:00:00.000Z');
  });
});

describe('quietWindowEnd (PLT-05.3)', () => {
  it('returns the end of the window when now is inside a window that crosses midnight', () => {
    // 23:30 local is inside 22:00–07:00; the window ends 07:00 the next day.
    const now = zonedToInstant(2026, 10, 27, 23, 30, TZ);
    expect(quietWindowEnd(now, TZ, '22:00', '07:00')?.toISOString()).toBe(zonedToInstant(2026, 10, 28, 7, 0, TZ).toISOString());
  });

  it('handles the early-morning half of the window', () => {
    const now = zonedToInstant(2026, 10, 28, 6, 15, TZ);
    expect(quietWindowEnd(now, TZ, '22:00', '07:00')?.toISOString()).toBe(zonedToInstant(2026, 10, 28, 7, 0, TZ).toISOString());
  });

  it('returns null outside the window', () => {
    const now = zonedToInstant(2026, 10, 28, 12, 0, TZ);
    expect(quietWindowEnd(now, TZ, '22:00', '07:00')).toBeNull();
  });

  it('handles a same-day window', () => {
    const now = zonedToInstant(2026, 10, 28, 13, 0, TZ);
    expect(quietWindowEnd(now, TZ, '12:00', '14:00')?.toISOString()).toBe(zonedToInstant(2026, 10, 28, 14, 0, TZ).toISOString());
  });
});

describe('study day and budget resets', () => {
  it('starts the study day at the rollover hour, so 02:00 belongs to the previous day', () => {
    const at0200 = zonedToInstant(2026, 10, 28, 2, 0, TZ);
    expect(studyDayStart(at0200, TZ, 4).toISOString()).toBe(zonedToInstant(2026, 10, 27, 4, 0, TZ).toISOString());
    const at0500 = zonedToInstant(2026, 10, 28, 5, 0, TZ);
    expect(studyDayStart(at0500, TZ, 4).toISOString()).toBe(zonedToInstant(2026, 10, 28, 4, 0, TZ).toISOString());
  });

  it('computes the next local midnight plus the offset', () => {
    const now = zonedToInstant(2026, 10, 31, 15, 0, TZ);
    expect(nextLocalMidnight(now, TZ, 5).toISOString()).toBe(zonedToInstant(2026, 11, 1, 0, 5, TZ).toISOString());
  });
});

describe('helpers', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(minutesOfDay('22:00')).toBe(1320);
    expect(minutesOfDay('07:30:00')).toBe(450);
  });

  it('reads local parts in the zone', () => {
    const p = localParts(new Date('2026-10-28T02:30:00Z'), TZ);
    expect(p).toMatchObject({ year: 2026, month: 10, day: 27, hour: 23, minute: 30 });
  });
});
