// Review session (Hoje / Praticar): the queue of card ids, answer history and undo. Ephemeral on
// purpose: the review data itself is in SQLite; a killed app just restarts the session.
import { create } from 'zustand';
import type { Grade } from 'ts-fsrs';
import type { AppDb } from '../db/client';
import { recordReview, undoReview, type ReviewSource } from '../db/hooks/review';
import { syncNow } from '../db/sync';

export interface AnsweredCard {
  logId: string;
  cardId: string;
  rating: Grade;
}

export interface SessionState {
  queue: string[];
  index: number;
  revealed: boolean;
  startedAt: number | null;
  history: AnsweredCard[];
  start: (cardIds: string[]) => void;
  reveal: () => void;
  /** Records the rating for the current card, then advances. Returns the new log id. */
  answer: (db: AppDb, rating: Grade, opts?: { durationMs?: number; source?: ReviewSource }) => Promise<string>;
  /** Undoes the last answer of this session (restores the card and steps back). */
  undo: (db: AppDb) => Promise<boolean>;
  /** Ends the session and syncs now. */
  finish: () => Promise<void>;
  reset: () => void;
  currentCardId: () => string | null;
}

const initial = {
  queue: [] as string[],
  index: 0,
  revealed: false,
  startedAt: null as number | null,
  history: [] as AnsweredCard[],
};

export const useSessionStore = create<SessionState>()((set, get) => ({
  ...initial,
  start: (cardIds) => set({ ...initial, queue: [...cardIds], startedAt: Date.now() }),
  reveal: () => set({ revealed: true }),
  currentCardId: () => get().queue[get().index] ?? null,

  answer: async (db, rating, opts = {}) => {
    const cardId = get().currentCardId();
    if (!cardId) throw new Error('Nenhum cartão em revisão.');
    const result = await recordReview(db, {
      cardId,
      rating,
      durationMs: opts.durationMs,
      source: opts.source ?? 'session',
    });
    set((s) => ({
      index: s.index + 1,
      revealed: false,
      history: [...s.history, { logId: result.logId, cardId, rating }],
    }));
    return result.logId;
  },

  undo: async (db) => {
    const { history, index } = get();
    const last = history[history.length - 1];
    if (!last) return false;
    await undoReview(db, last.logId);
    set({
      history: history.slice(0, -1),
      index: Math.max(0, index - 1),
      revealed: false,
    });
    return true;
  },

  finish: async () => {
    await syncNow();
  },

  reset: () => set({ ...initial }),
}));
