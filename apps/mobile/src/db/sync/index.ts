// Sync controller for the app: starts the engine on the ready database and installs the triggers
// (mobile-app.md §4.3): app foreground, connectivity regained, end of a session (syncNow), every
// 5 minutes while foregrounded, and after local writes (debounced).
import NetInfo from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { getAppDbSync } from '../client';
import { createSupabaseSyncTransport } from '../../api/sync-transport';
import { getDeviceId } from '../../lib/device';
import { flushPendingQuizSubmits } from '../../features/practice/finalize';
import { PERIODIC_SYNC_MS } from './constants';
import { subscribeLocalWrites } from './bus';
import { createSyncEngine, type SyncEngine, type SyncStatus } from './engine';

export interface SyncView {
  /** Outbox rows waiting to be sent. */
  pending: number;
  /** Rows the server refused too often (Configurações → Sincronização). */
  stuck: number;
  lastSyncAt: string | null;
  syncing: boolean;
  /** HTTP 426: the user must install a newer build. */
  updateRequired: boolean;
}

const LOCAL_WRITE_DEBOUNCE_MS = 3_000;

const EMPTY_VIEW: SyncView = { pending: 0, stuck: 0, lastSyncAt: null, syncing: false, updateRequired: false };

let engine: SyncEngine | null = null;
let stopTriggers: (() => void) | null = null;
let view: SyncView = EMPTY_VIEW;
const viewListeners = new Set<() => void>();

function toView(status: SyncStatus): SyncView {
  return {
    pending: status.pending,
    stuck: status.stuck,
    lastSyncAt: status.lastSyncedAt !== null ? new Date(status.lastSyncedAt).toISOString() : null,
    syncing: status.state === 'syncing',
    updateRequired: status.state === 'upgrade_required',
  };
}

function setView(next: SyncView): void {
  view = next;
  for (const listener of viewListeners) listener();
}

/**
 * Starts the sync controller on the (ready) database. Idempotent: a second call returns the same
 * cleanup function. Call from a component mounted inside <DatabaseProvider>.
 */
export function startSync(): () => void {
  if (stopTriggers) return stopTriggers;

  const current = createSyncEngine({
    db: getAppDbSync(),
    transport: createSupabaseSyncTransport(),
    deviceId: getDeviceId(),
    // Attempts whose rows just reached the server can now be graded (quiz-submit).
    onPushed: () => void flushPendingQuizSubmits(),
  });
  engine = current;
  setView(toView(current.getStatus()));
  const unsubscribeStatus = current.subscribe((status) => setView(toView(status)));

  const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void current.sync('foreground');
  });

  let wasOnline: boolean | null = null;
  const unsubscribeNet = NetInfo.addEventListener((state) => {
    const online = state.isConnected === true && state.isInternetReachable !== false;
    if (online && wasOnline === false) void current.sync('reconnect');
    wasOnline = online;
  });

  const periodic = setInterval(() => {
    if (AppState.currentState === 'active') void current.sync('periodic');
  }, PERIODIC_SYNC_MS);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const unsubscribeLocal = subscribeLocalWrites(() => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void current.sync('local_write');
    }, LOCAL_WRITE_DEBOUNCE_MS);
  });

  void current.sync('start');

  stopTriggers = () => {
    appStateSub.remove();
    unsubscribeNet();
    clearInterval(periodic);
    unsubscribeLocal();
    if (debounce !== null) clearTimeout(debounce);
    unsubscribeStatus();
    current.stop();
    engine = null;
    stopTriggers = null;
    setView(EMPTY_VIEW);
  };
  return stopTriggers;
}

/** Runs a sync now (e.g. at the end of a review or quiz session). Resolves when it finished. */
export async function syncNow(): Promise<void> {
  await engine?.sync('session_end');
}

/** Clears the failure count of stuck outbox rows and syncs them again. */
export async function retryStuckSync(): Promise<void> {
  await engine?.retryStuck();
}

/** Sync state for the UI. Re-renders on every engine status change. */
export function useSyncStatus(): SyncView {
  return useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
    () => view,
    () => EMPTY_VIEW,
  );
}
