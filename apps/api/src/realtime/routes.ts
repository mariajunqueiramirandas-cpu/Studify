// The realtime calls (api.md §8): realtime-stream opens the app's one SSE stream; realtime-join, realtime-leave and
// realtime-track change what it carries and answer over SSE like every other call (meta, then done.result).
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { authenticate, bearerToken } from '../shared/auth.ts';
import { mapError } from '../shared/errors.ts';
import { CORS_HEADERS, defineFunction, jsonResponse } from '../shared/http.ts';
import type { Deps } from '../shared/deps.ts';
import type { P2Deps } from '../shared-p2/deps.ts';
import type { RealtimeHub } from './hub.ts';

function hubOf(deps: Deps): RealtimeHub {
  const hub = (deps as P2Deps).realtime;
  if (!hub) throw new ApiFailure('internal_error');
  return hub;
}

/** The token's expiry (ms), read once Supabase Auth has accepted the token. */
function expiryOf(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/realtime-stream: the app's realtime stream. Answers `ready` with the connection id, then broadcast,
 * presence and change events for the channels joined on it, a heartbeat every 15 s, and `reauth` when the token
 * expires. It never ends on its own otherwise; the app reopens it after a drop and joins its channels again.
 */
export async function realtimeStream(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: { code: 'invalid_request', message: 'Use POST nesta chamada.' } }, 405);
  try {
    const user = await authenticate(req, deps.db);
    return hubOf(deps).open(user, expiryOf(bearerToken(req) ?? ''), CORS_HEADERS, req.signal);
  } catch (error) {
    const mapped = mapError(error);
    if (mapped.internal) console.error('[realtime-stream]', mapped.internal);
    return jsonResponse(mapped.body, mapped.status);
  }
}

const Topic = z.string().min(3).max(200);
const Presence = z.object({ key: z.string().min(1).max(100), payload: z.record(z.string(), z.unknown()).default({}) });

const JoinInput = z.object({ connection_id: z.string().uuid(), topic: Topic, presence: Presence.optional() });

export const realtimeJoin = defineFunction<z.infer<typeof JoinInput>>({
  name: 'realtime-join',
  mutating: false,
  readOnly: true,
  input: JoinInput,
  run: async (ctx) => {
    const { connection_id: connectionId, topic, presence } = ctx.input;
    const res = await hubOf(ctx.deps).join(connectionId, ctx.user, topic, presence ? { key: presence.key, payload: presence.payload } : null);
    if (!res.ok) throw new ApiFailure(res.code === 'not_found' ? 'not_found' : res.code === 'rate_limited' ? 'rate_limited' : res.code === 'forbidden' ? 'forbidden' : 'invalid_request');
    return ctx.json({ topic, presence: res.presence });
  },
});

const LeaveInput = z.object({ connection_id: z.string().uuid(), topic: Topic });

export const realtimeLeave = defineFunction<z.infer<typeof LeaveInput>>({
  name: 'realtime-leave',
  mutating: false,
  readOnly: true,
  input: LeaveInput,
  run: async (ctx) => ctx.json({ left: hubOf(ctx.deps).leave(ctx.input.connection_id, ctx.user, ctx.input.topic) }),
});

const TrackInput = z.object({ connection_id: z.string().uuid(), topic: Topic, payload: z.record(z.string(), z.unknown()) });

export const realtimeTrack = defineFunction<z.infer<typeof TrackInput>>({
  name: 'realtime-track',
  mutating: false,
  readOnly: true,
  input: TrackInput,
  run: async (ctx) => {
    if (JSON.stringify(ctx.input.payload).length > 2048) throw new ApiFailure('invalid_request');
    if (!hubOf(ctx.deps).track(ctx.input.connection_id, ctx.user, ctx.input.topic, ctx.input.payload)) throw new ApiFailure('not_found');
    return ctx.json({ tracked: true });
  },
});
