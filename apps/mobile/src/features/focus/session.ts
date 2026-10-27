// Modo foco glue (WEL-01/02): mirrors the store into the Android focus service, replays the actions taken from
// the notification or the overlay, gives XP per completed cycle (spec 13 §8.1) and records the session.
import { blockingAllowed, completedFocusCycles, focusCreditedMs, focusPhases } from '@studify/shared';
import * as Linking from 'expo-linking';
import { uuidv7 } from 'uuidv7';
import type { AppDb } from '../../db/client';
import { enqueueOutbox } from '../../db/outbox';
import { t } from '../../i18n';
import { focusBlocker } from '../../platform/focus';
import type { FocusNativeState } from '../../platform/types';
import { runPosition, runningMs, useFocusStore, type FocusRun } from '../../stores/focus';
import { awardXp } from '../motivation/xp';
import { blockedPackages } from './blocklist';

function nativeStrings(): Record<string, string> {
  return {
    focus: t('focus.phase.focus'),
    break: t('focus.phase.break'),
    long_break: t('focus.phase.long_break'),
    pause: t('focus.pause'),
    resume: t('focus.resume'),
    skip: t('focus.skip'),
    stop: t('focus.stop'),
    paused: t('focus.paused'),
    to_break: t('focus.alert_break'),
    to_focus: t('focus.alert_focus'),
    done: t('focus.alert_done'),
    overlay_title: t('focus.overlay_title', { time: '{time}' }),
    overlay_body: t('focus.overlay_body'),
    overlay_back: t('focus.overlay_back'),
    overlay_unlock: t('focus.overlay_unlock'),
    overlay_hold: t('focus.overlay_hold', { n: '{n}' }),
    overlay_end: t('focus.overlay_end'),
  };
}

export function focusNativeState(run: FocusRun, blockedApps: readonly string[], at = Date.now()): FocusNativeState {
  const phases = focusPhases(run.config);
  const pos = runPosition(run, at);
  const paused = run.pausedAt !== null;
  return {
    sessionId: run.id,
    phases: phases.map((p) => ({ kind: p.kind, ms: p.minutes * 60_000 })),
    index: Math.min(pos.index, Math.max(0, phases.length - 1)),
    phaseEndsAt: at + pos.remainingMs,
    paused,
    remainingMs: pos.remainingMs,
    // WEL-02.4: blocking never covers more than 3 h.
    blocked: run.block && blockingAllowed(run.config) ? [...blockedApps] : [],
    dnd: run.dnd,
    openUrl: Linking.createURL('/focus'),
    strings: nativeStrings(),
  };
}

/** Starts or refreshes the native session from the store (after start, pause, resume or skip in the app). */
export function syncFocusNative(db: AppDb, at = Date.now()): void {
  const { run } = useFocusStore.getState();
  if (!run || runPosition(run, at).done) {
    focusBlocker.stop();
    return;
  }
  focusBlocker.start(focusNativeState(run, run.block ? blockedPackages(db) : [], at));
}

/** Replays notification and overlay actions in the order they happened. */
export function replayFocusActions(): void {
  const store = useFocusStore.getState();
  for (const { action, at } of focusBlocker.consumeActions()) {
    if (action === 'pause') store.pause(at);
    else if (action === 'resume') store.resume(at);
    else if (action === 'skip') store.skip(at);
    else store.requestStop(at);
  }
}

/** One XP event per completed focus cycle; returns how many were newly awarded. */
export function awardFocusCycles(db: AppDb, userId: string, at = Date.now()): number {
  const { run, markAwarded } = useFocusStore.getState();
  if (!run) return 0;
  const done = completedFocusCycles(focusPhases(run.config), runPosition(run, at));
  let awarded = 0;
  for (let c = run.awardedCycles + 1; c <= done; c++) {
    awardXp(db, userId, { kind: 'focus_cycle_completed' }, { type: 'focus_cycle', id: uuidv7(), feature: 'WEL-01' }, new Date(at));
    awarded++;
  }
  markAwarded(done);
  return awarded;
}

export interface FocusSummary {
  cycles: number;
  cyclesPlanned: number;
  minutes: number;
  interruptions: number;
  blockedAttempts: number;
}

/**
 * Ends the session: awards the last cycles, stops the native service and records the study session (kind
 * `focus`). Active minutes are the credited focus time only (WEL-01.6), so they never double other sessions.
 */
export function finishFocus(db: AppDb, userId: string, at = Date.now()): FocusSummary | null {
  replayFocusActions();
  awardFocusCycles(db, userId, at);
  const blockedAttempts = focusBlocker.blockedAttempts();
  focusBlocker.stop();
  const run = useFocusStore.getState().end(at);
  if (!run) return null;
  const phases = focusPhases(run.config);
  const elapsed = runningMs(run, at);
  const cycles = completedFocusCycles(phases, runPosition(run, at));
  const minutes = Math.round(focusCreditedMs(phases, run.skips, run.credited, elapsed) / 60_000);
  enqueueOutbox(db, {
    kind: 'study_session',
    id: run.id,
    payload: {
      id: run.id,
      user_id: userId,
      kind: 'focus',
      plan_item_id: run.planItemId,
      goal_id: run.goalId,
      started_at: new Date(run.startedAt).toISOString(),
      ended_at: new Date(at).toISOString(),
      active_minutes: minutes,
      activities: [],
      planned_focus_minutes: run.config.focusMin * run.config.cycles,
      cycles_planned: run.config.cycles,
      cycles_done: cycles,
      interruptions: run.interruptions,
      // WEL-02.5: only the count leaves the device.
      blocked_attempts: run.block ? blockedAttempts : null,
      dnd_used: run.dnd,
    },
  });
  return { cycles, cyclesPlanned: run.config.cycles, minutes, interruptions: run.interruptions, blockedAttempts };
}
