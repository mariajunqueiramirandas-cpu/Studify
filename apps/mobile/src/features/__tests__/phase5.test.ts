/// <reference types="jest" />
jest.mock('expo-sqlite', () => require('../../db/testing/expo-sqlite.mock'));
jest.mock('../../api/supabase', () => ({ supabase: {} }));
jest.mock('../../lib/kv', () => {
  const store = new Map<string, unknown>();
  const kv = {
    getString: (k: string) => store.get(k) as string | undefined,
    getBoolean: (k: string) => store.get(k) as boolean | undefined,
    getNumber: (k: string) => store.get(k) as number | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
    remove: (k: string) => void store.delete(k),
  };
  return { getKv: () => kv, kvStateStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } };
});
jest.mock('expo-calendar', () => ({}));

import { eq } from 'drizzle-orm';
import { outbox, wellbeingCheckins } from '../../db/schema';
import { seedProfile, USER_ID } from '../../db/testing/seed';
import { createTestDb } from '../../db/testing/test-db';
import { runPosition, useFocusStore } from '../../stores/focus';
import { busyByDate } from '../calendar/sync';
import { finishFocus } from '../focus/session';
import { checkinMoods, saveCheckin, weekStartOf } from '../wellbeing/checkin';

const MIN = 60_000;
const T0 = new Date(2026, 9, 27, 15, 0).getTime();
const config = { focusMin: 25, breakMin: 5, cycles: 2 };

describe('Modo foco store (WEL-01)', () => {
  beforeEach(() => useFocusStore.setState({ run: null }));

  it('excludes paused time and lets a skip end the running phase', () => {
    const s = useFocusStore.getState();
    s.start({ config, preset: '25_5', block: false, dnd: false }, T0);
    s.pause(T0 + 10 * MIN);
    s.resume(T0 + 20 * MIN);
    expect(runPosition(useFocusStore.getState().run!, T0 + 30 * MIN)).toMatchObject({ index: 0, remainingMs: 5 * MIN });
    useFocusStore.getState().skip(T0 + 30 * MIN);
    const pos = runPosition(useFocusStore.getState().run!, T0 + 31 * MIN);
    expect(pos.phase?.kind).toBe('break');
    expect(pos.remainingMs).toBe(4 * MIN);
  });

  it('a skip while paused resumes the session', () => {
    const s = useFocusStore.getState();
    s.start({ config, preset: '25_5', block: false, dnd: false }, T0);
    s.pause(T0 + 5 * MIN);
    useFocusStore.getState().skip(T0 + 8 * MIN);
    const run = useFocusStore.getState().run!;
    expect(run.pausedAt).toBeNull();
    expect(runPosition(run, T0 + 9 * MIN)).toMatchObject({ index: 1, remainingMs: 4 * MIN });
  });
});

describe('finishFocus', () => {
  beforeEach(() => useFocusStore.setState({ run: null }));

  it('records a focus study session with the credited minutes and one XP event per cycle', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    const s = useFocusStore.getState();
    s.start({ config, preset: '25_5', block: false, dnd: false, planItemId: null }, T0);
    // On Studify the whole first focus, away (screen on) for 10 min of the second one.
    s.noteAway(true, T0 + 35 * MIN);
    s.setCredit(false, T0 + 35 * MIN);
    s.setCredit(true, T0 + 45 * MIN);
    const summary = finishFocus(db as never, USER_ID, T0 + 56 * MIN)!;
    expect(summary).toMatchObject({ cycles: 2, cyclesPlanned: 2, minutes: 40, interruptions: 1 });
    expect(useFocusStore.getState().run).toBeNull();
    const rows = db.select().from(outbox).all();
    const session = rows.find((r) => r.kind === 'study_session')!;
    expect(session.payload).toMatchObject({ kind: 'focus', active_minutes: 40, cycles_planned: 2, cycles_done: 2, interruptions: 1, planned_focus_minutes: 50, blocked_attempts: null });
    const xp = rows.filter((r) => r.kind === 'xp_event');
    expect(xp).toHaveLength(2);
    expect(xp[0]!.payload).toMatchObject({ amount: 3, source_feature: 'WEL-01', ref_type: 'focus_cycle' });
  });
});

describe('calendar busy time (GOL-09.2)', () => {
  it('splits events per day and ignores all-day and free ones', () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
    const busy = busyByDate(
      [
        { start: at(27, 15), end: at(27, 16, 30), allDay: false, free: false },
        { start: at(27, 23), end: at(28, 1), allDay: false, free: false },
        { start: at(28, 0), end: at(29, 0), allDay: true, free: false },
        { start: at(28, 18), end: at(28, 19), allDay: false, free: true },
      ],
      ['2026-10-27', '2026-10-28'],
    );
    expect(busy.get('2026-10-27')).toEqual([
      { start: 900, end: 990 },
      { start: 1380, end: 1440 },
    ]);
    expect(busy.get('2026-10-28')).toEqual([{ start: 0, end: 60 }]);
  });
});

describe('weekly check-in (WEL-03.4)', () => {
  it('keeps one answer per week, on the phone', async () => {
    const { db } = await createTestDb();
    expect(weekStartOf(new Date(2026, 9, 27))).toBe('2026-10-26');
    expect(weekStartOf(new Date(2026, 10, 1))).toBe('2026-10-26');
    saveCheckin(db as never, 3, new Date(2026, 9, 20));
    saveCheckin(db as never, 1, new Date(2026, 9, 27));
    saveCheckin(db as never, 9, new Date(2026, 9, 28));
    expect(checkinMoods(db as never)).toEqual([3, 5]);
    expect(db.select().from(wellbeingCheckins).where(eq(wellbeingCheckins.weekStart, '2026-10-26')).all()).toHaveLength(1);
  });
});
