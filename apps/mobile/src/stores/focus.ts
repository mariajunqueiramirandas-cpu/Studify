// Modo foco (WEL-01/02). The running session lives here, persisted to MMKV so a killed app picks it back up; the
// timeline itself is the shared `focusPhaseWindows` over running time (wall time minus pauses, with skips). The
// Android focus service mirrors it for the notification, alerts and blocking, and queues the actions taken there.
import { FOCUS_PRESETS, focusPhases, focusPositionAt, type FocusConfig, type FocusPosition } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kvStateStorage } from '../lib/kv';

export type FocusPresetId = '25_5' | '50_10' | 'custom';

export interface FocusRun {
  id: string;
  config: FocusConfig;
  preset: FocusPresetId;
  startedAt: number;
  /** Wall time the session was paused at; null while running. */
  pausedAt: number | null;
  pausedMs: number;
  /** Running time of each skip. */
  skips: number[];
  /** WEL-01.5 soft-focus interruptions (left Studify with the screen on during a focus phase). */
  interruptions: number;
  /** Focus cycles already given XP. */
  awardedCycles: number;
  /** Running-time intervals credited as active study (WEL-01.6); `creditFrom` is the open one. */
  credited: [number, number][];
  creditFrom: number | null;
  /** When the student left Studify mid-focus: "Voltou! Bora continuar?" on return. */
  awayAt: number | null;
  block: boolean;
  dnd: boolean;
  planItemId: string | null;
  goalId: string | null;
  subjectId: string | null;
  label: string | null;
  /** Set when "Encerrar" came from the notification or the overlay: the screen wraps the session up. */
  stopRequestedAt: number | null;
}

export interface FocusStartInput {
  config: FocusConfig;
  preset: FocusPresetId;
  block: boolean;
  dnd: boolean;
  planItemId?: string | null;
  goalId?: string | null;
  subjectId?: string | null;
  label?: string | null;
}

interface FocusState {
  run: FocusRun | null;
  lastConfig: FocusConfig;
  lastPreset: FocusPresetId;
  blockEnabled: boolean;
  dndEnabled: boolean;
  start: (input: FocusStartInput, at?: number) => FocusRun;
  pause: (at?: number) => void;
  resume: (at?: number) => void;
  skip: (at?: number) => void;
  requestStop: (at?: number) => void;
  setCredit: (on: boolean, at?: number) => void;
  noteAway: (interruption: boolean, at?: number) => void;
  clearAway: () => void;
  markAwarded: (cycles: number) => void;
  /** Ends the session: closes the open credit interval and returns the final run. */
  end: (at?: number) => FocusRun | null;
  setPrefs: (p: Partial<Pick<FocusState, 'blockEnabled' | 'dndEnabled'>>) => void;
}

/** Running time of a session at `at` (pauses excluded). */
export function runningMs(run: FocusRun, at: number): number {
  return Math.max(0, (run.pausedAt ?? at) - run.startedAt - run.pausedMs);
}

export function runPosition(run: FocusRun, at: number): FocusPosition {
  return focusPositionAt(focusPhases(run.config), runningMs(run, at), run.skips);
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set, get) => ({
      run: null,
      lastConfig: FOCUS_PRESETS[0]!.config,
      lastPreset: '25_5',
      blockEnabled: false,
      dndEnabled: false,
      start: (input, at = Date.now()) => {
        const run: FocusRun = {
          id: uuidv7(),
          config: input.config,
          preset: input.preset,
          startedAt: at,
          pausedAt: null,
          pausedMs: 0,
          skips: [],
          interruptions: 0,
          awardedCycles: 0,
          credited: [],
          creditFrom: 0,
          awayAt: null,
          block: input.block,
          dnd: input.dnd,
          planItemId: input.planItemId ?? null,
          goalId: input.goalId ?? null,
          subjectId: input.subjectId ?? null,
          label: input.label ?? null,
          stopRequestedAt: null,
        };
        set({ run, lastConfig: input.config, lastPreset: input.preset });
        return run;
      },
      pause: (at = Date.now()) => {
        const run = get().run;
        if (!run || run.pausedAt !== null) return;
        set({ run: { ...run, pausedAt: at } });
      },
      resume: (at = Date.now()) => {
        const run = get().run;
        if (!run || run.pausedAt === null) return;
        set({ run: { ...run, pausedMs: run.pausedMs + Math.max(0, at - run.pausedAt), pausedAt: null } });
      },
      skip: (at = Date.now()) => {
        const run = get().run;
        if (!run) return;
        const t = runningMs(run, at);
        // A skip while paused also resumes: the next phase starts now.
        const resumed = run.pausedAt === null ? run : { ...run, pausedMs: run.pausedMs + Math.max(0, at - run.pausedAt), pausedAt: null };
        set({ run: { ...resumed, skips: [...run.skips, t] } });
      },
      requestStop: (at = Date.now()) => {
        const run = get().run;
        if (run && run.stopRequestedAt === null) set({ run: { ...run, stopRequestedAt: at } });
      },
      setCredit: (on, at = Date.now()) => {
        const run = get().run;
        if (!run) return;
        const t = runningMs(run, at);
        if (on && run.creditFrom === null) set({ run: { ...run, creditFrom: t } });
        if (!on && run.creditFrom !== null) set({ run: { ...run, credited: [...run.credited, [run.creditFrom, t]], creditFrom: null } });
      },
      noteAway: (interruption, at = Date.now()) => {
        const run = get().run;
        if (!run) return;
        set({ run: { ...run, interruptions: run.interruptions + (interruption ? 1 : 0), awayAt: interruption ? at : run.awayAt } });
      },
      clearAway: () => {
        const run = get().run;
        if (run?.awayAt) set({ run: { ...run, awayAt: null } });
      },
      markAwarded: (cycles) => {
        const run = get().run;
        if (run && cycles > run.awardedCycles) set({ run: { ...run, awardedCycles: cycles } });
      },
      end: (at = Date.now()) => {
        const run = get().run;
        if (!run) return null;
        const t = runningMs(run, at);
        const final: FocusRun = run.creditFrom === null ? run : { ...run, credited: [...run.credited, [run.creditFrom, t]], creditFrom: null };
        set({ run: null });
        return { ...final, pausedAt: final.pausedAt ?? at };
      },
      setPrefs: (p) => set(p),
    }),
    { name: 'studify.focus.v1', storage: createJSONStorage(() => kvStateStorage) },
  ),
);
