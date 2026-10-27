// Salas de estudo (SOC-05): the shared focus timer, stamped with server time by room-control and replayed
// identically by every phone (SOC-05.3), plus the room limits (SOC-05.5–05.6). Pure functions.

export const ROOM_LIMITS = {
  maxMembers: 20,
  emptyCloseMs: 10 * 60 * 1000,
  maxLifetimeMs: 4 * 60 * 60 * 1000,
  reactionIntervalMs: 5000,
} as const;

/** SOC-05.1 presets ("25/5", "50/10"); custom configs are clamped by validTimerConfig. */
export const ROOM_TIMER_PRESETS = [
  { focus_min: 25, break_min: 5 },
  { focus_min: 50, break_min: 10 },
] as const;

export interface RoomTimerConfig {
  focus_min: number;
  break_min: number;
}

export type RoomPhase = 'idle' | 'focus' | 'break' | 'paused';

export interface RoomTimerState {
  phase: RoomPhase;
  /** Completed focus phases count up when a focus phase ends. */
  cycle: number;
  started_at?: string | null;
  ends_at?: string | null;
  /** While paused: the phase that was running and its remaining time. */
  paused_phase?: 'focus' | 'break' | null;
  remaining_ms?: number | null;
}

export type RoomTimerAction = 'start' | 'pause' | 'resume' | 'skip';

export function validTimerConfig(config: RoomTimerConfig): boolean {
  return (
    Number.isInteger(config.focus_min) &&
    Number.isInteger(config.break_min) &&
    config.focus_min >= 5 &&
    config.focus_min <= 120 &&
    config.break_min >= 1 &&
    config.break_min <= 30
  );
}

function phaseMs(config: RoomTimerConfig, phase: 'focus' | 'break'): number {
  return (phase === 'focus' ? config.focus_min : config.break_min) * 60_000;
}

function running(phase: 'focus' | 'break', cycle: number, startMs: number, config: RoomTimerConfig): RoomTimerState {
  return {
    phase,
    cycle,
    started_at: new Date(startMs).toISOString(),
    ends_at: new Date(startMs + phaseMs(config, phase)).toISOString(),
    paused_phase: null,
    remaining_ms: null,
  };
}

/**
 * Rolls a running timer forward to `now`: focus → break → focus …, counting a cycle at the end of each
 * focus phase. Paused and idle timers do not move.
 */
export function advanceRoomTimer(state: RoomTimerState, config: RoomTimerConfig, now: Date): RoomTimerState {
  if (state.phase !== 'focus' && state.phase !== 'break') return state;
  let current = state;
  let guard = 0;
  while ((current.phase === 'focus' || current.phase === 'break') && current.ends_at && Date.parse(current.ends_at) <= now.getTime() && guard < 1000) {
    const endMs = Date.parse(current.ends_at);
    const next = current.phase === 'focus' ? 'break' : 'focus';
    current = running(next, current.phase === 'focus' ? current.cycle + 1 : current.cycle, endMs, config);
    guard++;
  }
  return current;
}

/** SOC-05.3: host controls. Unknown transitions (pause while idle, …) leave the state unchanged. */
export function applyRoomTimerAction(state: RoomTimerState, config: RoomTimerConfig, action: RoomTimerAction, now: Date): RoomTimerState {
  const nowMs = now.getTime();
  const current = advanceRoomTimer(state, config, now);
  switch (action) {
    case 'start':
      if (current.phase === 'idle') return running('focus', current.cycle, nowMs, config);
      return current;
    case 'pause':
      if (current.phase === 'focus' || current.phase === 'break') {
        const remaining = Math.max(0, Date.parse(current.ends_at ?? now.toISOString()) - nowMs);
        return { phase: 'paused', cycle: current.cycle, paused_phase: current.phase, remaining_ms: remaining, started_at: null, ends_at: null };
      }
      return current;
    case 'resume':
      if (current.phase === 'paused' && current.paused_phase) {
        const remaining = current.remaining_ms ?? phaseMs(config, current.paused_phase);
        return {
          phase: current.paused_phase,
          cycle: current.cycle,
          started_at: now.toISOString(),
          ends_at: new Date(nowMs + remaining).toISOString(),
          paused_phase: null,
          remaining_ms: null,
        };
      }
      return current;
    case 'skip': {
      const phase = current.phase === 'paused' ? current.paused_phase : current.phase;
      if (phase === 'focus') return running('break', current.cycle + 1, nowMs, config);
      if (phase === 'break') return running('focus', current.cycle, nowMs, config);
      return current;
    }
  }
}

/** What the phones render: phase, time left and cycle at `now`. */
export function roomTimerView(state: RoomTimerState, config: RoomTimerConfig, now: Date): { phase: RoomPhase; remainingMs: number; cycle: number } {
  const current = advanceRoomTimer(state, config, now);
  if (current.phase === 'paused') return { phase: 'paused', remainingMs: current.remaining_ms ?? 0, cycle: current.cycle };
  if (current.phase === 'idle') return { phase: 'idle', remainingMs: phaseMs(config, 'focus'), cycle: current.cycle };
  return { phase: current.phase, remainingMs: Math.max(0, Date.parse(current.ends_at ?? now.toISOString()) - now.getTime()), cycle: current.cycle };
}

/** SOC-05.5: one reaction per member per 5 s. */
export function canReact(lastReactionAt: string | null | undefined, now: Date): boolean {
  if (!lastReactionAt) return true;
  return now.getTime() - Date.parse(lastReactionAt) >= ROOM_LIMITS.reactionIntervalMs;
}

/** SOC-05.6: a room closes after 10 min with nobody in it, or 4 h after it opened. */
export function roomShouldClose(room: { created_at: string; last_active_at: string }, membersInside: number, now: Date): boolean {
  const nowMs = now.getTime();
  if (nowMs - Date.parse(room.created_at) >= ROOM_LIMITS.maxLifetimeMs) return true;
  return membersInside === 0 && nowMs - Date.parse(room.last_active_at) >= ROOM_LIMITS.emptyCloseMs;
}

/** SOC-05.4 group goal progress, capped at the target. */
export function roomGoalProgress(contributions: readonly number[], target: number): { progress: number; target: number; reached: boolean } {
  const total = contributions.reduce((s, n) => s + Math.max(0, n), 0);
  return { progress: Math.min(total, target), target, reached: total >= target };
}
