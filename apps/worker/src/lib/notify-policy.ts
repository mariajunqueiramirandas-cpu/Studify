// PLT-05 delivery policy as a pure function: channel toggles, device tokens, the 3-per-day cap for
// unrequested notifications, and quiet hours (deferred to the end of the window, PLT-05.3).
import type { NotifyChannel } from './notify-catalog.ts';

export interface PolicyInput {
  delivery: 'push' | 'local';
  channel: NotifyChannel;
  countsTowardCap: boolean;
  channelEnabled: boolean;
  hasToken: boolean;
  /** Unrequested, delivered notifications already sent in this study day. */
  sentToday: number;
  inQuiet: boolean;
}

export const DAILY_CAP = 3;

export type PolicyDecision =
  | { action: 'send' }
  | { action: 'defer' }
  | { action: 'drop'; reason: 'disabled' | 'no_token' | 'daily_cap' | 'local_only' };

export function decideDelivery(input: PolicyInput): PolicyDecision {
  if (input.delivery === 'local') return { action: 'drop', reason: 'local_only' };
  if (!input.channelEnabled) return { action: 'drop', reason: 'disabled' };
  if (!input.hasToken) return { action: 'drop', reason: 'no_token' };
  if (input.countsTowardCap && input.sentToday >= DAILY_CAP) return { action: 'drop', reason: 'daily_cap' };
  if (input.inQuiet) return { action: 'defer' };
  return { action: 'send' };
}

/** Channel toggles from profiles.settings.notifications; a missing key means on (PLT-05.5 defaults). */
export function channelEnabled(settings: Record<string, unknown> | null | undefined, channel: NotifyChannel): boolean {
  const notifications = settings?.notifications;
  if (!notifications || typeof notifications !== 'object') return true;
  const value = (notifications as Record<string, unknown>)[channel];
  return typeof value === 'boolean' ? value : true;
}
