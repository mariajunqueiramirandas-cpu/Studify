// UI preferences (persisted to MMKV). Accessibility options mirror mobile-app.md §11 and §13.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kvStateStorage } from '../lib/kv';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface UiState {
  theme: ThemeMode;
  /** Dyslexia-friendly font (Atkinson Hyperlegible) and letter spacing. */
  easyReading: boolean;
  highContrast: boolean;
  reduceMotion: boolean;
  /** Timed activities use 1.5× time. */
  extraTime: boolean;
  /** WEL-04.8 read-aloud speed, 0.75×–2×. */
  readAloudRate: number;
  /** A light tick under the finger on buttons, answers and ratings. */
  haptics: boolean;
  setTheme: (theme: ThemeMode) => void;
  setEasyReading: (value: boolean) => void;
  setHighContrast: (value: boolean) => void;
  setReduceMotion: (value: boolean) => void;
  setExtraTime: (value: boolean) => void;
  setReadAloudRate: (value: number) => void;
  setHaptics: (value: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      easyReading: false,
      highContrast: false,
      reduceMotion: false,
      extraTime: false,
      readAloudRate: 1,
      haptics: true,
      setTheme: (theme) => set({ theme }),
      setEasyReading: (easyReading) => set({ easyReading }),
      setHighContrast: (highContrast) => set({ highContrast }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setExtraTime: (extraTime) => set({ extraTime }),
      setReadAloudRate: (readAloudRate) => set({ readAloudRate: Math.min(2, Math.max(0.75, readAloudRate)) }),
      setHaptics: (haptics) => set({ haptics }),
    }),
    {
      name: 'studify.ui.v1',
      storage: createJSONStorage(() => kvStateStorage),
    },
  ),
);
