// Tiny pub/sub: local writes that should trigger a sync (e.g. a review recorded by the widget).
// The sync controller subscribes; writers never import the controller (avoids cycles, keeps
// headless tasks free of React Native imports).
import type { SyncReason } from './engine';

type Listener = (reason: SyncReason) => void;

const listeners = new Set<Listener>();

export function subscribeLocalWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyLocalWrite(reason: SyncReason = 'local_write'): void {
  for (const listener of listeners) {
    listener(reason);
  }
}
