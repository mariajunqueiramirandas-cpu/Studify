// Realtime REST broadcast (api §8.2): POST {SUPABASE_URL}/realtime/v1/api/broadcast with the service key.
// Failures are logged, never thrown: the state change is already committed, a missed broadcast only
// delays the screen until its next event or refetch.
import type { Broadcaster, BroadcastMessage } from './deps.ts';

export function makeRestBroadcaster(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): Broadcaster {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/realtime/v1/api/broadcast`;
  return async (messages: BroadcastMessage[]): Promise<void> => {
    if (messages.length === 0) return;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
      });
      if (!res.ok) console.error(`realtime broadcast failed: HTTP ${res.status}`);
    } catch (err) {
      console.error('realtime broadcast failed', err);
    }
  };
}
