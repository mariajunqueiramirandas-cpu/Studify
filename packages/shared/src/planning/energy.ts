// Energy-aware windows and calendar sync (GOL-10, GOL-09; learning-engine §11.10, spec 07 §8.8). Time-zone free:
// the device converts calendar events and activity to local minutes of the day before calling these. Event
// titles never reach these functions, only busy intervals (GOL-09.2).
import { hhmmToMin, minToHHMM } from './util.ts';

export const ENERGY = {
  bucketMinutes: 120,
  minActiveDays: 14,
  minEvents: 300,
  /** z for the 90% interval (normal approximation). */
  z90: 1.6449,
  maxGoodWindows: 2,
  snapMinutes: 15,
  /** Study reminders never after 20:00 (spec 13 §8.7). */
  reminderLatest: 20 * 60,
} as const;

/** 2-hour bucket 0–11 of a local minute of the day. */
export function energyBucketOf(minuteOfDay: number): number {
  return Math.min(11, Math.max(0, Math.floor(minuteOfDay / ENERGY.bucketMinutes)));
}

/** residual = observed (1/0) − expected (R for cards, p̂ for questions). */
export function performanceResidual(correct: boolean, expected: number): number {
  return (correct ? 1 : 0) - Math.min(1, Math.max(0, expected));
}

export interface ResidualEvent {
  minuteOfDay: number;
  residual: number;
  localDate: string;
}

export interface WindowStat {
  bucket: number;
  n: number;
  mean: number;
  ciLow: number | null;
  ciHigh: number | null;
  good: boolean;
}

export interface PerformanceWindows {
  /** Enough data (≥ 14 active days and ≥ 300 events) to tell the student their best windows (GOL-10.1). */
  ready: boolean;
  overallMean: number;
  windows: WindowStat[];
  /** At most 2 good windows, best first. Empty until `ready`. */
  best: number[];
}

/**
 * Per-bucket mean residual with a 90% normal interval; a window is good when its lower bound beats the overall
 * mean residual (spec 07 §8.8). Buckets with fewer than 2 events have no interval and are never good.
 */
export function performanceWindows(events: readonly ResidualEvent[]): PerformanceWindows {
  const days = new Set(events.map((e) => e.localDate));
  const ready = days.size >= ENERGY.minActiveDays && events.length >= ENERGY.minEvents;
  const overallMean = events.length ? events.reduce((s, e) => s + e.residual, 0) / events.length : 0;
  const byBucket = new Map<number, number[]>();
  for (const e of events) {
    const b = energyBucketOf(e.minuteOfDay);
    byBucket.set(b, [...(byBucket.get(b) ?? []), e.residual]);
  }
  const windows: WindowStat[] = [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, xs]) => {
      const n = xs.length;
      const mean = xs.reduce((s, x) => s + x, 0) / n;
      if (n < 2) return { bucket, n, mean, ciLow: null, ciHigh: null, good: false };
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
      const half = (ENERGY.z90 * sd) / Math.sqrt(n);
      const ciLow = mean - half;
      return { bucket, n, mean, ciLow, ciHigh: mean + half, good: ready && ciLow > overallMean };
    });
  const best = windows
    .filter((w) => w.good)
    .sort((a, b) => b.mean - a.mean || a.bucket - b.bucket)
    .slice(0, ENERGY.maxGoodWindows)
    .map((w) => w.bucket);
  return { ready, overallMean, windows, best };
}

export interface MinuteInterval {
  start: number;
  end: number;
}

/** Sorted, merged intervals clipped to the day (0–1440). */
export function mergeIntervals(intervals: readonly MinuteInterval[]): MinuteInterval[] {
  const sorted = intervals
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(1440, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: MinuteInterval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Quiet hours as intervals of one day (the window may wrap midnight, default 22:00–07:00). */
export function quietIntervals(quietStart: string, quietEnd: string): MinuteInterval[] {
  const s = hhmmToMin(quietStart);
  const e = hhmmToMin(quietEnd);
  if (s === e) return [];
  return s < e ? [{ start: s, end: e }] : [{ start: s, end: 1440 }, { start: 0, end: e }];
}

/** Free intervals of the study window after busy calendar time and quiet hours (GOL-09.2, GOL-10.3). */
export function freeIntervals(window: { start: string; end: string }, busy: readonly MinuteInterval[], quiet: { start: string; end: string }): MinuteInterval[] {
  const ws = hhmmToMin(window.start);
  const we = hhmmToMin(window.end);
  const blocked = mergeIntervals([...busy, ...quietIntervals(quiet.start, quiet.end)]);
  const out: MinuteInterval[] = [];
  let cursor = ws;
  for (const b of blocked) {
    if (b.end <= cursor) continue;
    if (b.start >= we) break;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, we) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < we) out.push({ start: cursor, end: we });
  return out;
}

/** GOL-09.2: the only number that leaves the device per date — free minutes in the study window. */
export function freeMinutes(window: { start: string; end: string }, busy: readonly MinuteInterval[], quiet: { start: string; end: string }): number {
  return freeIntervals(window, busy, quiet).reduce((s, i) => s + (i.end - i.start), 0);
}

export interface BlockUnit {
  id: string;
  minutes: number;
  /** learn, low-mastery practice and simulados (GOL-10.2). */
  demanding: boolean;
}

export interface PlacedBlock {
  id: string;
  start: string;
  end: string;
  inGoodWindow: boolean;
}

/**
 * Calendar blocks for one day (spec 07 §8.8): demanding units first into good windows, then everything else into
 * the earliest free time; starts snap to 15 minutes and blocks never overlap busy time or quiet hours. Units that
 * do not fit are left out (the plan keeps them; only the calendar event is skipped).
 */
export function placeBlocks(
  units: readonly BlockUnit[],
  free: readonly MinuteInterval[],
  goodBuckets: readonly number[],
): { placed: PlacedBlock[]; unplaced: string[] } {
  const slots = free.map((f) => ({ start: Math.ceil(f.start / ENERGY.snapMinutes) * ENERGY.snapMinutes, end: f.end })).filter((s) => s.end > s.start);
  const good = goodBuckets.map((b) => ({ start: b * ENERGY.bucketMinutes, end: (b + 1) * ENERGY.bucketMinutes }));
  const placed: PlacedBlock[] = [];
  const unplaced: string[] = [];
  const take = (slotIndex: number, start: number, minutes: number) => {
    const slot = slots[slotIndex]!;
    const end = start + minutes;
    const before = { start: slot.start, end: start };
    const after = { start: Math.ceil(end / ENERGY.snapMinutes) * ENERGY.snapMinutes, end: slot.end };
    slots.splice(slotIndex, 1, ...[before, after].filter((s) => s.end - s.start >= ENERGY.snapMinutes));
    return end;
  };
  const tryPlace = (u: BlockUnit, inGood: boolean): boolean => {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (inGood) {
        for (const g of good) {
          const start = Math.max(s.start, Math.ceil(g.start / ENERGY.snapMinutes) * ENERGY.snapMinutes);
          if (start < g.end && start + u.minutes <= s.end) {
            const end = take(i, start, u.minutes);
            placed.push({ id: u.id, start: minToHHMM(start), end: minToHHMM(end), inGoodWindow: true });
            return true;
          }
        }
      } else if (s.end - s.start >= u.minutes) {
        const start = s.start;
        const end = take(i, start, u.minutes);
        const inGoodWindow = good.some((g) => start >= g.start && start < g.end);
        placed.push({ id: u.id, start: minToHHMM(start), end: minToHHMM(end), inGoodWindow });
        return true;
      }
    }
    return false;
  };
  const demanding = units.filter((u) => u.demanding);
  const light = units.filter((u) => !u.demanding);
  for (const u of demanding) if (!(good.length && tryPlace(u, true)) && !tryPlace(u, false)) unplaced.push(u.id);
  for (const u of light) if (!tryPlace(u, false)) unplaced.push(u.id);
  placed.sort((a, b) => a.start.localeCompare(b.start));
  return { placed, unplaced };
}

/**
 * GOL-10.2 without calendar sync: when the app opens inside a good window, demanding items go first; otherwise the
 * planned order stays. Stable within each group.
 */
export function orderByEnergy<T extends { demanding: boolean }>(items: readonly T[], minuteOfDay: number, goodBuckets: readonly number[]): T[] {
  if (!goodBuckets.includes(energyBucketOf(minuteOfDay))) return [...items];
  return [...items.filter((i) => i.demanding), ...items.filter((i) => !i.demanding)];
}

/** Reminder times at the start of each good window inside the study window, never after 20:00 or in quiet hours. */
export function suggestedReminderTimes(goodBuckets: readonly number[], window: { start: string; end: string }, quiet: { start: string; end: string }): string[] {
  const free = freeIntervals(window, [], quiet);
  const out: string[] = [];
  for (const b of goodBuckets) {
    const gs = b * ENERGY.bucketMinutes;
    const ge = gs + ENERGY.bucketMinutes;
    const slot = free.find((f) => f.end > gs && f.start < ge);
    if (!slot) continue;
    const t = Math.max(gs, slot.start);
    if (t <= ENERGY.reminderLatest) out.push(minToHHMM(t));
  }
  return [...new Set(out)].sort();
}
