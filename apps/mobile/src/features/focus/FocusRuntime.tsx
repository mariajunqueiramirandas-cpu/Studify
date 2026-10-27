// App-wide side of Modo foco: soft-focus interruptions (WEL-01.5), credited time (WEL-01.6), cycle XP and the
// actions queued by the Android focus service. Renders nothing.
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useOverlay } from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { t } from '../../i18n';
import { focusBlocker } from '../../platform/focus';
import { runPosition, useFocusStore } from '../../stores/focus';
import { useSession } from '../auth/session';
import { awardFocusCycles, replayFocusActions, syncFocusNative } from './session';

function inFocusPhase(at: number): boolean {
  const run = useFocusStore.getState().run;
  if (!run || run.pausedAt !== null) return false;
  const pos = runPosition(run, at);
  return !pos.done && pos.phase?.kind === 'focus';
}

export function FocusRuntime() {
  const db = useDb();
  const { userId } = useSession();
  const overlay = useOverlay();
  const hasRun = useFocusStore((s) => s.run !== null);

  useEffect(() => {
    if (!hasRun) return;
    replayFocusActions();
    // After a process death the service is gone: bring the countdown notification back.
    if (!focusBlocker.isRunning()) syncFocusNative(db);
    useFocusStore.getState().setCredit(AppState.currentState === 'active');
    const offAction = focusBlocker.onAction(() => replayFocusActions());
    const sub = AppState.addEventListener('change', (state) => {
      const store = useFocusStore.getState();
      const now = Date.now();
      if (state === 'active') {
        replayFocusActions();
        store.setCredit(true, now);
        if (useFocusStore.getState().run?.awayAt) {
          overlay.snack(t('focus.welcome_back'));
          store.clearAway();
        }
        if (useFocusStore.getState().run && !focusBlocker.isRunning()) syncFocusNative(db, now);
        return;
      }
      if (state !== 'background') return;
      const interactive = focusBlocker.isInteractive();
      const focusing = inFocusPhase(now);
      // Screen on → the student switched apps: an interruption. Screen off is fine (studying from paper), and
      // counts as study time only for a session started from a plan item (WEL-01.6).
      if (interactive === true) {
        store.setCredit(false, now);
        if (focusing) store.noteAway(true, now);
      } else {
        store.setCredit(interactive === false && !!store.run?.planItemId, now);
      }
    });
    return () => {
      sub.remove();
      offAction();
    };
  }, [hasRun, overlay, db]);

  useEffect(() => {
    if (!hasRun || !userId) return;
    const award = () => awardFocusCycles(db, userId);
    award();
    const timer = setInterval(award, 30_000);
    return () => clearInterval(timer);
  }, [hasRun, userId, db]);

  return null;
}
