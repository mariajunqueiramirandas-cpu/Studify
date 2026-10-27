// Quiz runner state (Praticar → quiz). Persisted to MMKV on every change so a crash or a killed
// process never loses answers or the elapsed time (mobile-app.md §3, §15). Answers become outbox
// rows only on submit, after which the store is cleared.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { uuidv7 } from 'uuidv7';
import type { AppDb } from '../db/client';
import { enqueueOutbox } from '../db/outbox';
import { quizAttempts } from '../db/schema';
import { syncNow } from '../db/sync';
import { kvStateStorage } from '../lib/kv';
import { flushPendingQuizSubmits, queuePendingQuizSubmit } from '../features/practice/finalize';
import type { AttemptAnswerInput } from '@studify/shared';

export type Confidence = 1 | 2 | 3 | 4;

export interface AnswerDraft {
  /** Client UUID v7 of the attempt_answers row, assigned when the first answer is recorded. */
  clientId: string;
  response: unknown;
  confidence: Confidence | null;
  hintsUsed: number;
  timeSpentMs: number;
  answeredAt: number;
}

export interface QuizRunnerState {
  attemptId: string | null;
  quizId: string | null;
  userId: string | null;
  questionIds: string[];
  index: number;
  answers: Record<string, AnswerDraft>;
  startedAt: number | null;
  /** Seconds paused, excluding an open pause. */
  pausedSeconds: number;
  pausedAt: number | null;
  timeLimitS: number | null;
  start: (input: { attemptId?: string; quizId: string; userId: string; questionIds: string[]; timeLimitS: number | null; now?: number }) => void;
  goTo: (index: number) => void;
  answer: (questionId: string, input: { response: unknown; confidence?: Confidence | null; hintsUsed?: number; now?: number }) => void;
  pause: (now?: number) => void;
  resume: (now?: number) => void;
  /** Whole seconds elapsed on the clock (pauses excluded). */
  elapsedSeconds: (now?: number) => number;
  /**
   * Writes the attempt and its answers to the outbox and a pending quiz-submit to MMKV (durable until
   * the server grades it), syncs, then clears the runner.
   */
  submit: (db: AppDb, now?: number) => Promise<string | null>;
  clear: () => void;
}

const initial = {
  attemptId: null,
  quizId: null,
  userId: null,
  questionIds: [] as string[],
  index: 0,
  answers: {} as Record<string, AnswerDraft>,
  startedAt: null,
  pausedSeconds: 0,
  pausedAt: null,
  timeLimitS: null,
};

export const useQuizRunnerStore = create<QuizRunnerState>()(
  persist(
    (set, get) => ({
      ...initial,

      start: ({ attemptId, quizId, userId, questionIds, timeLimitS, now = Date.now() }) =>
        set({
          ...initial,
          attemptId: attemptId ?? uuidv7(),
          quizId,
          userId,
          questionIds: [...questionIds],
          timeLimitS,
          startedAt: now,
        }),

      goTo: (index) => set({ index: Math.min(Math.max(0, index), Math.max(0, get().questionIds.length - 1)) }),

      answer: (questionId, input) => {
        const now = input.now ?? Date.now();
        const existing = get().answers[questionId];
        const last = existing?.answeredAt ?? get().startedAt ?? now;
        set((s) => ({
          answers: {
            ...s.answers,
            [questionId]: {
              clientId: existing?.clientId ?? uuidv7(),
              response: input.response,
              confidence: input.confidence ?? existing?.confidence ?? null,
              hintsUsed: input.hintsUsed ?? existing?.hintsUsed ?? 0,
              timeSpentMs: (existing?.timeSpentMs ?? 0) + Math.max(0, now - last),
              answeredAt: now,
            },
          },
        }));
      },

      pause: (now = Date.now()) => {
        if (get().pausedAt === null) set({ pausedAt: now });
      },

      resume: (now = Date.now()) => {
        const { pausedAt, pausedSeconds } = get();
        if (pausedAt === null) return;
        set({ pausedAt: null, pausedSeconds: pausedSeconds + Math.max(0, now - pausedAt) / 1000 });
      },

      elapsedSeconds: (now = Date.now()) => {
        const { startedAt, pausedSeconds, pausedAt } = get();
        if (startedAt === null) return 0;
        const openPause = pausedAt !== null ? Math.max(0, now - pausedAt) / 1000 : 0;
        return Math.max(0, Math.floor((now - startedAt) / 1000 - pausedSeconds - openPause));
      },

      submit: async (db, now = Date.now()) => {
        const state = get();
        if (!state.attemptId || !state.quizId || !state.userId || state.startedAt === null) return null;
        const attemptId = state.attemptId;
        const elapsed = get().elapsedSeconds(now);

        // Durable first: the pending finalization outlives a kill before or after the outbox write.
        const answers: AttemptAnswerInput[] = Object.entries(state.answers).map(([questionId, draft]) => ({
          id: draft.clientId,
          question_id: questionId,
          response: draft.response ?? null,
          ...(draft.confidence !== null ? { confidence: draft.confidence } : {}),
          time_spent_ms: Math.max(0, Math.round(draft.timeSpentMs)),
          hints_used: Math.max(0, Math.round(draft.hintsUsed)),
        }));
        queuePendingQuizSubmit({ attemptId, finishedAt: new Date(now).toISOString(), answers, now });

        db.transaction((tx) => {
          tx.insert(quizAttempts)
            .values({
              id: attemptId,
              userId: state.userId as string,
              quizId: state.quizId as string,
              status: 'submitted',
              startedAt: new Date(state.startedAt as number),
              finishedAt: new Date(now),
              pausedSeconds: Math.round(state.pausedSeconds),
              deviceId: null,
              score: null,
              grade: null,
              areaResults: null,
              essayId: null,
              createdAt: new Date(state.startedAt as number),
              updatedAt: new Date(now),
              deletedAt: null,
              pulledAt: null,
            })
            .onConflictDoNothing()
            .run();
          enqueueOutbox(tx, {
            kind: 'quiz_attempt',
            id: attemptId,
            entityId: attemptId,
            createdAt: now,
            payload: {
              id: attemptId,
              quiz_id: state.quizId,
              status: 'submitted',
              started_at: new Date(state.startedAt as number).toISOString(),
              finished_at: new Date(now).toISOString(),
              paused_seconds: Math.round(state.pausedSeconds),
              elapsed_seconds: elapsed,
            },
          });

          for (const [questionId, draft] of Object.entries(state.answers)) {
            enqueueOutbox(tx, {
              kind: 'attempt_answer',
              id: draft.clientId,
              entityId: draft.clientId,
              createdAt: now,
              payload: {
                id: draft.clientId,
                attempt_id: attemptId,
                question_id: questionId,
                response: draft.response,
                confidence: draft.confidence,
                hints_used: draft.hintsUsed,
                time_spent_ms: draft.timeSpentMs,
                answered_at: new Date(draft.answeredAt).toISOString(),
              },
            });
          }
        });

        void syncNow().then(() => flushPendingQuizSubmits());
        set({ ...initial });
        return attemptId;
      },

      clear: () => set({ ...initial }),
    }),
    {
      name: 'studify.quiz-runner.v1',
      storage: createJSONStorage(() => kvStateStorage),
      partialize: (s) => ({
        attemptId: s.attemptId,
        quizId: s.quizId,
        userId: s.userId,
        questionIds: s.questionIds,
        index: s.index,
        answers: s.answers,
        startedAt: s.startedAt,
        pausedSeconds: s.pausedSeconds,
        pausedAt: s.pausedAt,
        timeLimitS: s.timeLimitS,
      }),
    },
  ),
);
