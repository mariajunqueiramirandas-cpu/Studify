import { RealtimeClient, rowTopic, type RealtimeTransport } from '../realtime-client';

/** A server stream the test writes SSE frames into. */
function serverStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTransport() {
  const streams: Array<ReturnType<typeof serverStream>> = [];
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  let refreshes = 0;
  const responses: Array<Response | null> = [];
  const transport: RealtimeTransport = {
    open: async () => {
      const preset = responses.shift();
      if (preset) return preset;
      const s = serverStream();
      streams.push(s);
      return s.response;
    },
    call: async (name, body) => {
      calls.push({ name, body });
      if (name === 'realtime-join') {
        if (String(body.topic).includes('forbidden')) throw new Error('forbidden');
        return { topic: body.topic, presence: { k1: [{ user_id: 'u1' }] } };
      }
      return { ok: true };
    },
    refresh: async () => { refreshes += 1; },
    sleep: async () => undefined,
  };
  return { transport, streams, calls, responses, refreshes: () => refreshes };
}

describe('RealtimeClient', () => {
  it('opens one stream, joins on ready, and routes broadcasts, presence and row changes by topic', async () => {
    const t = fakeTransport();
    const client = new RealtimeClient(t.transport);
    const statuses: string[] = [];
    const states: unknown[] = [];
    const nudges: unknown[] = [];
    const room = client.channel('room:r1', { presence: { key: 'me' } });
    room
      .on('broadcast', { event: 'timer' }, (m) => nudges.push(m.payload))
      .on('presence', { event: 'sync' }, () => states.push(room.presenceState()))
      .subscribe((s) => statuses.push(s));
    const changes: unknown[] = [];
    client.channel(rowTopic('ai_jobs', 'user_id', 'u1')).on('change', (c) => changes.push(c)).subscribe();
    await flush();
    expect(t.streams).toHaveLength(1);
    t.streams[0]!.send('ready', { connection_id: 'c1' });
    await flush(); await flush();
    expect(t.calls.filter((c) => c.name === 'realtime-join').map((c) => c.body.topic)).toEqual(['room:r1', 'rows:ai_jobs:user_id=u1']);
    expect(statuses).toEqual(['SUBSCRIBED']);
    expect(room.presenceState()).toEqual({ k1: [{ user_id: 'u1' }] });

    expect(await room.track({ status: 'focus' })).toBe('ok');
    expect(t.calls.at(-1)).toEqual({ name: 'realtime-track', body: { connection_id: 'c1', topic: 'room:r1', key: 'me', payload: { status: 'focus' } } });

    t.streams[0]!.send('broadcast', { topic: 'room:r1', event: 'timer', payload: { left: 60 } });
    t.streams[0]!.send('broadcast', { topic: 'room:other', event: 'timer', payload: { left: 1 } });
    t.streams[0]!.send('presence', { topic: 'room:r1', state: { me: [{ status: 'focus' }] } });
    t.streams[0]!.send('change', { topic: 'rows:ai_jobs:user_id=u1', op: 'UPDATE', new: { id: 'j1', status: 'running' }, old: null });
    await flush();
    expect(nudges).toEqual([{ left: 60 }]);
    expect(states).toEqual([{ me: [{ status: 'focus' }] }]);
    expect(changes).toEqual([{ op: 'UPDATE', new: { id: 'j1', status: 'running' }, old: null }]);
    await client.close();
  });

  it('reconnects after a drop, joins again and re-sends its presence', async () => {
    const t = fakeTransport();
    const client = new RealtimeClient(t.transport);
    const statuses: string[] = [];
    const battle = client.channel('battle:b1', { presence: { key: 'me' } }).subscribe((s) => statuses.push(s));
    await flush();
    t.streams[0]!.send('ready', { connection_id: 'c1' });
    await flush(); await flush();
    await battle.track({ nickname: 'Ana' });
    t.streams[0]!.end();
    await flush(); await flush();
    expect(statuses).toEqual(['SUBSCRIBED', 'CHANNEL_ERROR']);
    expect(t.streams).toHaveLength(2);
    t.streams[1]!.send('ready', { connection_id: 'c2' });
    await flush(); await flush(); await flush();
    expect(statuses.at(-1)).toBe('SUBSCRIBED');
    const lastTrack = t.calls.filter((c) => c.name === 'realtime-track').at(-1);
    expect(lastTrack?.body).toEqual({ connection_id: 'c2', topic: 'battle:b1', key: 'me', payload: { nickname: 'Ana' } });
    await client.close();
  });

  it('refreshes the session on reauth and on a 401, then reopens', async () => {
    const t = fakeTransport();
    t.responses.push(new Response('{}', { status: 401 }));
    const client = new RealtimeClient(t.transport);
    client.channel('user:u1').subscribe();
    await flush(); await flush();
    expect(t.refreshes()).toBe(1);
    t.streams[0]!.send('ready', { connection_id: 'c1' });
    t.streams[0]!.send('reauth', {});
    t.streams[0]!.end();
    await flush(); await flush(); await flush();
    expect(t.refreshes()).toBe(2);
    expect(t.streams).toHaveLength(2);
    await client.close();
  });

  it('reports a refused channel and leaves a topic only when its last channel goes', async () => {
    const t = fakeTransport();
    const client = new RealtimeClient(t.transport);
    const refused: string[] = [];
    client.channel('user:forbidden').subscribe((s) => refused.push(s));
    const a = client.channel('rows:podcast_episodes:id=p1').subscribe();
    const b = client.channel('rows:podcast_episodes:id=p1').subscribe();
    await flush();
    t.streams[0]!.send('ready', { connection_id: 'c1' });
    await flush(); await flush();
    expect(refused).toEqual(['CHANNEL_ERROR']);
    await client.removeChannel(a);
    expect(t.calls.some((c) => c.name === 'realtime-leave')).toBe(false);
    await client.removeChannel(b);
    expect(t.calls.filter((c) => c.name === 'realtime-leave').map((c) => c.body.topic)).toEqual(['rows:podcast_episodes:id=p1']);
    await client.close();
  });
});
