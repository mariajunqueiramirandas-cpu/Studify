import { create } from 'zustand';
import type { MistakeCause } from './types';

/**
 * Causes picked in the feedback panel before the attempt syncs (PRA-04). The mistakes rows are
 * created server-side on submit; the result screen applies these picks once the rows exist.
 */
interface CauseState {
  byAttempt: Record<string, Record<string, MistakeCause>>;
  set: (attemptId: string, questionId: string, cause: MistakeCause) => void;
  take: (attemptId: string) => Record<string, MistakeCause>;
}

export const usePickedCauses = create<CauseState>((set, get) => ({
  byAttempt: {},
  set: (attemptId, questionId, cause) => set((s) => ({ byAttempt: { ...s.byAttempt, [attemptId]: { ...(s.byAttempt[attemptId] ?? {}), [questionId]: cause } } })),
  take: (attemptId) => {
    const picks = get().byAttempt[attemptId] ?? {};
    set((s) => {
      const next = { ...s.byAttempt };
      delete next[attemptId];
      return { byAttempt: next };
    });
    return picks;
  },
}));
