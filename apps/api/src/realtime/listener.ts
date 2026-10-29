// The row-change feed (ADR 0012): one dedicated connection LISTENs on studify_row_changes, where the triggers of
// migration 20261029200000_row_change_notify announce each change. A dropped connection reconnects with backoff;
// changes made while it was down are not replayed (screens refetch when their stream reconnects).
import pg from 'pg';
import { log } from '../log.ts';
import type { RowChange } from './hub.ts';

export const ROW_CHANGE_CHANNEL = 'studify_row_changes';

export function listenRowChanges(connectionString: string, onChange: (change: RowChange) => void): { stop(): Promise<void> } {
  let client: pg.Client | null = null;
  let stopped = false;
  let delay = 500;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = new pg.Client({ connectionString, application_name: 'studify-api-listen' });
    next.on('notification', (message) => {
      if (message.channel !== ROW_CHANGE_CHANNEL || !message.payload) return;
      try {
        onChange(JSON.parse(message.payload) as RowChange);
      } catch (err) {
        log('warn', 'row change notification unreadable', { message: err instanceof Error ? err.message : String(err) });
      }
    });
    next.on('error', (err) => {
      log('warn', 'row change listener lost its connection', { message: err.message });
      void next.end().catch(() => undefined);
      if (client === next) client = null;
      schedule();
    });
    try {
      await next.connect();
      await next.query(`listen ${ROW_CHANGE_CHANNEL}`);
      client = next;
      delay = 500;
    } catch (err) {
      log('warn', 'row change listener could not connect', { message: err instanceof Error ? err.message : String(err) });
      void next.end().catch(() => undefined);
      schedule();
    }
  };

  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
    retry.unref?.();
    delay = Math.min(delay * 2, 30_000);
  };

  void connect();
  return {
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await client?.end().catch(() => undefined);
      client = null;
    },
  };
}
