// Turma membership, settings, blocks and display names (SOC-01, SOC-02.11, SOC-X.3). Every query is
// scoped by the caller id the handler already authenticated; nothing here trusts client input.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure } from '@studify/shared';

export interface ActiveMember {
  role: 'owner' | 'moderator' | 'member';
  nickname: string | null;
  accepts_duels: boolean;
}

export async function activeMember(db: SupabaseClient, groupId: string, userId: string): Promise<ActiveMember | null> {
  const { data, error } = await db
    .from('class_group_members')
    .select('role, status, nickname, accepts_duels')
    .eq('class_group_id', groupId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    role: data.role as ActiveMember['role'],
    nickname: (data.nickname as string | null) ?? null,
    accepts_duels: data.accepts_duels !== false,
  };
}

/** Active member or 403 not_member. */
export async function requireActiveMember(db: SupabaseClient, groupId: string, userId: string): Promise<ActiveMember> {
  const member = await activeMember(db, groupId, userId);
  if (!member) throw new ApiFailure('not_member');
  return member;
}

export interface GroupRow {
  id: string;
  settings: Record<string, unknown>;
}

export async function loadGroup(db: SupabaseClient, groupId: string): Promise<GroupRow | null> {
  const { data, error } = await db.from('class_groups').select('id, settings').eq('id', groupId).is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id as string, settings: (data.settings as Record<string, unknown>) ?? {} };
}

/** True when either user blocked the other (user_blocks is directional; the pair is hidden both ways). */
export async function blockedEitherWay(db: SupabaseClient, a: string, b: string): Promise<boolean> {
  const first = await db.from('user_blocks').select('blocker_id').eq('blocker_id', a).eq('blocked_id', b).maybeSingle();
  if (first.error) throw first.error;
  if (first.data) return true;
  const second = await db.from('user_blocks').select('blocker_id').eq('blocker_id', b).eq('blocked_id', a)
    .maybeSingle();
  if (second.error) throw second.error;
  return second.data !== null;
}

/** Display name used when no Turma nickname exists (profiles.display_name). Never the email. */
export async function displayNameOf(db: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await db.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  if (error) throw error;
  return (data?.display_name as string | undefined) ?? 'Estudante';
}

/** Turma nickname first (SOC-01.9), profile display name as the fallback. */
export function nicknameOrName(member: ActiveMember | null, displayName: string): string {
  return member?.nickname?.trim() || displayName;
}
