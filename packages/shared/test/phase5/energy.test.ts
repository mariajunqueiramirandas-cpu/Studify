import { describe, expect, it } from 'vitest';
import {
  energyBucketOf,
  freeIntervals,
  freeMinutes,
  orderByEnergy,
  performanceResidual,
  performanceWindows,
  placeBlocks,
  suggestedReminderTimes,
  type ResidualEvent,
} from '../../src/planning/index.ts';

const quiet = { start: '22:00', end: '07:00' };

describe('performance windows (GOL-10, spec 07 §8.8)', () => {
  it('buckets and residuals', () => {
    expect(energyBucketOf(0)).toBe(0);
    expect(energyBucketOf(15 * 60 + 30)).toBe(7);
    expect(energyBucketOf(23 * 60 + 59)).toBe(11);
    expect(performanceResidual(true, 0.75)).toBeCloseTo(0.25);
    expect(performanceResidual(false, 0.75)).toBeCloseTo(-0.75);
  });

  function events(days: number, perDay: number): ResidualEvent[] {
    const out: ResidualEvent[] = [];
    for (let d = 0; d < days; d++) {
      for (let i = 0; i < perDay; i++) {
        const morning = i % 2 === 0;
        // Mornings (bucket 4) are clearly better than evenings (bucket 9); a little noise keeps an SD.
        out.push({ localDate: `2026-10-${String(d + 1).padStart(2, '0')}`, minuteOfDay: morning ? 9 * 60 : 19 * 60, residual: morning ? 0.2 + (i % 3) * 0.01 : -0.2 + (i % 3) * 0.01 });
      }
    }
    return out;
  }

  it('needs ≥ 14 active days and ≥ 300 events before naming good windows', () => {
    expect(performanceWindows(events(13, 30)).ready).toBe(false);
    expect(performanceWindows(events(13, 30)).best).toEqual([]);
    const w = performanceWindows(events(15, 22));
    expect(w.ready).toBe(true);
    expect(w.best).toEqual([4]);
    expect(w.windows.find((x) => x.bucket === 9)?.good).toBe(false);
  });
});

describe('calendar sync and placement (GOL-09, spec 07 §8.8)', () => {
  const window = { start: '14:00', end: '21:30' };

  it('busy time and quiet hours reduce the free minutes; only the number leaves the device', () => {
    const busy = [{ start: 15 * 60, end: 16 * 60 }, { start: 15 * 60 + 30, end: 17 * 60 }];
    expect(freeIntervals(window, busy, quiet)).toEqual([{ start: 14 * 60, end: 15 * 60 }, { start: 17 * 60, end: 21 * 60 + 30 }]);
    expect(freeMinutes(window, busy, quiet)).toBe(60 + 270);
    expect(freeMinutes({ start: '20:00', end: '23:00' }, [], quiet)).toBe(120);
  });

  it('demanding units go to good windows, light ones fill the rest, starts snap to 15 min, no overlap', () => {
    const free = freeIntervals(window, [{ start: 14 * 60, end: 14 * 60 + 10 }], quiet);
    const r = placeBlocks(
      [
        { id: 'review', minutes: 20, demanding: false },
        { id: 'learn', minutes: 30, demanding: true },
        { id: 'mock', minutes: 60, demanding: true },
        { id: 'huge', minutes: 600, demanding: false },
      ],
      free,
      [9],
    );
    expect(r.unplaced).toEqual(['huge']);
    const byId = Object.fromEntries(r.placed.map((p) => [p.id, p]));
    expect(byId.learn).toMatchObject({ start: '18:00', end: '18:30', inGoodWindow: true });
    expect(byId.mock).toMatchObject({ start: '18:30', end: '19:30', inGoodWindow: true });
    expect(byId.review).toMatchObject({ start: '14:15', end: '14:35', inGoodWindow: false });
    for (const p of r.placed) expect(Number(p.start.slice(3)) % 15).toBe(0);
  });

  it('orders Hoje by energy only inside a good window; reminders never after 20:00', () => {
    const items = [{ id: 'a', demanding: false }, { id: 'b', demanding: true }];
    expect(orderByEnergy(items, 18 * 60 + 5, [9]).map((i) => i.id)).toEqual(['b', 'a']);
    expect(orderByEnergy(items, 15 * 60, [9]).map((i) => i.id)).toEqual(['a', 'b']);
    expect(suggestedReminderTimes([7, 10, 11], window, quiet)).toEqual(['14:00', '20:00']);
    expect(suggestedReminderTimes([9], window, quiet)).toEqual(['18:00']);
  });
});
