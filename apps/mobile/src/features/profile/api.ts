import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import type { Intent } from '../auth/onboarding';

/** Merges keys into profiles.settings (ProfileSettings, data-model §5.1). */
export async function updateSettings(patch: Record<string, unknown>) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error('not_signed_in');
  const { data, error } = await supabase.from('profiles').select('settings').eq('id', uid).single();
  if (error) throw error;
  const settings = { ...((data?.settings as Record<string, unknown>) ?? {}), ...patch };
  const { error: e2 } = await supabase.from('profiles').update({ settings }).eq('id', uid);
  if (e2) throw e2;
  return settings;
}

/** S-AUTH-07 only decides which call to action Hoje shows (GOL-01). */
export async function saveIntent(intent: Intent) {
  await updateSettings({ intent });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  const { userId } = useSession();
  return async (patch: Partial<{ display_name: string; school_year: string; avatar_preset: string }>, settings?: Record<string, unknown>) => {
    if (Object.keys(patch).length) {
      const { error } = await supabase.from('profiles').update(patch).eq('id', userId!);
      if (error) throw error;
    }
    if (settings) await updateSettings(settings);
    await qc.invalidateQueries({ queryKey: ['profile', userId] });
  };
}

export interface AiUsageToday {
  pct: number;
  byFeature: { feature: string; pct: number }[];
}

/** PLT-04.2: today's usage as % of the limit — money is never shown to students. */
export function useAiUsage() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['aiUsage', userId],
    enabled: !!userId,
    queryFn: async (): Promise<AiUsageToday> => {
      const { data, error } = await supabase.rpc('my_ai_usage_today');
      if (!error && data) return data as AiUsageToday;
      return { pct: 0, byFeature: [] };
    },
  });
}

export async function requestExport() {
  return callFunction<Record<string, never>, { export_id: string }>('account-export', {}, { idempotencyKey: uuidv7() });
}

export async function deleteAccount(otpCode: string, deleteSharedUploads: boolean) {
  return callFunction<{ otp_code: string; delete_shared_uploads: boolean }, { deletion_id: string; completes_by: string }>('account-delete', { otp_code: otpCode, delete_shared_uploads: deleteSharedUploads }, { idempotencyKey: uuidv7() });
}

/** Recomeçar do zero: wipes everything on the server, keeps the login (account-reset). */
export async function resetAccount(otpCode: string) {
  return callFunction<{ otp_code: string }, { reset: true }>('account-reset', { otp_code: otpCode }, { idempotencyKey: uuidv7() });
}

export async function sendFeedback(userId: string, body: string) {
  const { error } = await supabase.from('app_feedback').insert({ id: uuidv7(), user_id: userId, body });
  if (error) throw error;
}
