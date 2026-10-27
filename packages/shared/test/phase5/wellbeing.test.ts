import { describe, expect, it } from 'vitest';
import {
  blockingAllowed,
  burnoutNudges,
  completedFocusCycles,
  focusCreditedMs,
  focusPhaseWindows,
  focusPhases,
  focusPositionAt,
  focusTotalMinutes,
  validateFocusConfig,
  type BurnoutInput,
} from '../../src/learning/index.ts';

describe('Modo foco (WEL-01)', () => {
  it('validates the custom limits', () => {
    expect(validateFocusConfig({ focusMin: 25, breakMin: 5, cycles: 4 })).toEqual([]);
    expect(validateFocusConfig({ focusMin: 9, breakMin: 31, cycles: 7 })).toEqual(['focus_min', 'break_min', 'cycles']);
  });

  it('builds the timeline with a long break after the 4th cycle and no trailing break', () => {
    const phases = focusPhases({ focusMin: 25, breakMin: 5, cycles: 5 });
    expect(phases.map((p) => `${p.kind}:${p.minutes}`)).toEqual([
      'focus:25', 'break:5', 'focus:25', 'break:5', 'focus:25', 'break:5', 'focus:25', 'long_break:15', 'focus:25',
    ]);
    expect(focusTotalMinutes({ focusMin: 25, breakMin: 5, cycles: 4 })).toBe(115);
  });

  it('blocking covers at most 3 hours (WEL-02.4)', () => {
    expect(blockingAllowed({ focusMin: 50, breakMin: 10, cycles: 3 })).toBe(true);
    expect(blockingAllowed({ focusMin: 90, breakMin: 10, cycles: 3 })).toBe(false);
  });

  it('tracks the position, with skipped phases ending early', () => {
    const phases = focusPhases({ focusMin: 25, breakMin: 5, cycles: 2 });
    expect(focusPositionAt(phases, 10 * 60_000)).toMatchObject({ index: 0, remainingMs: 15 * 60_000, done: false });
    expect(focusPositionAt(phases, 26 * 60_000)).toMatchObject({ index: 1, remainingMs: 4 * 60_000 });
    const skipped = focusPositionAt(phases, 26 * 60_000, [25 * 60_000 + 30_000]);
    expect(skipped).toMatchObject({ index: 2, phase: { kind: 'focus' } });
    const done = focusPositionAt(phases, 60 * 60_000);
    expect(done.done).toBe(true);
    expect(completedFocusCycles(phases, done)).toBe(2);
    expect(completedFocusCycles(phases, focusPositionAt(phases, 26 * 60_000))).toBe(1);
  });

  it('each skip ends exactly one phase', () => {
    const phases = focusPhases({ focusMin: 25, breakMin: 5, cycles: 2 });
    // Skipping the first focus at 10 min, then the break right away.
    const w = focusPhaseWindows(phases, [10 * 60_000, 10 * 60_000 + 1_000]);
    expect(w.map((x) => [x.start, x.end])).toEqual([
      [0, 10 * 60_000],
      [10 * 60_000, 10 * 60_000 + 1_000],
      [10 * 60_000 + 1_000, 35 * 60_000 + 1_000],
    ]);
  });

  it('credits only the time inside focus phases, never twice (WEL-01.6)', () => {
    const phases = focusPhases({ focusMin: 25, breakMin: 5, cycles: 2 });
    const min = 60_000;
    // On Studify 0–20 and 18–28 (overlap), break 25–30 does not count, then 30–40 of the second focus.
    expect(focusCreditedMs(phases, [], [[0, 20 * min], [18 * min, 28 * min], [30 * min, 40 * min]], 60 * min)).toBe(35 * min);
    // Nothing after `until`.
    expect(focusCreditedMs(phases, [], [[0, 60 * min]], 10 * min)).toBe(10 * min);
  });
});

describe('burnout guard (WEL-03, spec 13 §8.10)', () => {
  const base: BurnoutInput = {
    minuteOfDay: 16 * 60,
    nightWeekday: 1,
    examEve: false,
    dailyGoalMinutes: 30,
    todayActiveMinutes: 40,
    continuousMinutes: 10,
    inFocusTimer: false,
    inTimedActivity: false,
    lateNightMinutesTonight: 0,
    sessionItems: [],
    last7: [],
    checkins: [],
    shownToday: {},
    lateNightShownTonight: false,
    nudgesEnabled: true,
  };

  it('long session at 50 min, once more (stronger) at 90, never inside a focus timer', () => {
    expect(burnoutNudges({ ...base, continuousMinutes: 50 })).toEqual([{ kind: 'long_session' }]);
    expect(burnoutNudges({ ...base, continuousMinutes: 60, shownToday: { long_session: 1 } })).toEqual([]);
    expect(burnoutNudges({ ...base, continuousMinutes: 90, shownToday: { long_session: 1 } })).toEqual([{ kind: 'long_session', strong: true }]);
    expect(burnoutNudges({ ...base, continuousMinutes: 95, shownToday: { long_session: 2 } })).toEqual([]);
    expect(burnoutNudges({ ...base, continuousMinutes: 70, inFocusTimer: true })).toEqual([]);
  });

  it('daily load above max(2 × goal, 180)', () => {
    expect(burnoutNudges({ ...base, todayActiveMinutes: 180 })).toEqual([]);
    expect(burnoutNudges({ ...base, todayActiveMinutes: 181 })).toEqual([{ kind: 'daily_load' }]);
    expect(burnoutNudges({ ...base, dailyGoalMinutes: 120, todayActiveMinutes: 200 })).toEqual([]);
  });

  it('late night only on school nights, once per night, 22:30 on an exam eve', () => {
    const late = { ...base, minuteOfDay: 23 * 60 + 20, lateNightMinutesTonight: 12 };
    expect(burnoutNudges(late)).toEqual([{ kind: 'late_night' }]);
    expect(burnoutNudges({ ...late, nightWeekday: 5 })).toEqual([]); // Friday night
    expect(burnoutNudges({ ...late, lateNightShownTonight: true })).toEqual([]);
    expect(burnoutNudges({ ...late, lateNightMinutesTonight: 9 })).toEqual([]);
    expect(burnoutNudges({ ...late, minuteOfDay: 22 * 60 + 40 })).toEqual([]);
    expect(burnoutNudges({ ...late, minuteOfDay: 22 * 60 + 40, examEve: true })).toEqual([{ kind: 'late_night' }]);
    expect(burnoutNudges({ ...late, minuteOfDay: 60 })).toEqual([{ kind: 'late_night' }]);
  });

  it('performance drop over the last 20 items vs the first 20', () => {
    const items = [...Array.from({ length: 20 }, () => ({ correct: true, ms: 8000 })), ...Array.from({ length: 20 }, (_, i) => ({ correct: i % 2 === 0, ms: 8000 }))];
    expect(burnoutNudges({ ...base, sessionItems: items })).toEqual([{ kind: 'performance_drop' }]);
    const slower = [...Array.from({ length: 20 }, () => ({ correct: true, ms: 6000 })), ...Array.from({ length: 20 }, () => ({ correct: true, ms: 9500 }))];
    expect(burnoutNudges({ ...base, sessionItems: slower })).toEqual([{ kind: 'performance_drop' }]);
    expect(burnoutNudges({ ...base, sessionItems: items.slice(0, 39) })).toEqual([]);
  });

  it('overload trend offers to rebalance', () => {
    const last7 = [0.9, 0.85, 0.8, 0.8, 0.7, 0.65, 0.6].map((accuracy) => ({ activeMinutes: 60, accuracy }));
    expect(burnoutNudges({ ...base, last7 })).toEqual([{ kind: 'overload_trend', action: 'rebalance' }]);
    const improving = last7.map((d, i) => ({ ...d, accuracy: 0.6 + i * 0.05 }));
    expect(burnoutNudges({ ...base, last7: improving })).toEqual([]);
  });

  it('caps: 2 per day overall, nothing during a timed activity, nothing when turned off', () => {
    expect(burnoutNudges({ ...base, todayActiveMinutes: 200, shownToday: { long_session: 1, late_night: 1 } })).toEqual([]);
    expect(burnoutNudges({ ...base, todayActiveMinutes: 200, inTimedActivity: true })).toEqual([]);
    expect(burnoutNudges({ ...base, todayActiveMinutes: 200, nudgesEnabled: false })).toEqual([]);
  });

  it('two lowest check-ins show the help card even with nudges off', () => {
    expect(burnoutNudges({ ...base, checkins: [3, 1, 1], nudgesEnabled: false })).toEqual([{ kind: 'checkin_low', action: 'help_card' }]);
    expect(burnoutNudges({ ...base, checkins: [1, 2, 1] })).toEqual([]);
  });
});
