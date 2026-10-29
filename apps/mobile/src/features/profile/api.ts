import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';
import type { Intent } from '../auth/onboarding';

/** Merges keys into profiles.settings (ProfileSettings, data-model §5.1). */
export async function updateSettings(patch: Record<string, unknown>) {
  const res = await data<{ settings: Record<string, unknown> }>('profile-update', { settings: patch });
  return res.settings;
}

/** S-AUTH-07 only decides which call to action Hoje shows (GOL-01). */
export async function saveIntent(intent: Intent) {
  await updateSettings({ intent });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  const { userId } = useSession();
  return async (patch: Partial<{ display_name: string; school_year: string; avatar_preset: string }>, settings?: Record<string, unknown>) => {
    if (Object.keys(patch).length || settings) await data('profile-update', { ...patch, ...(settings ? { settings } : {}) });
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
      try {
        const usage = await data<AiUsageToday | null>('profile-ai-usage');
        if (usage) return usage;
      } catch {
        // no usage yet or not reachable: show zero, as before
      }
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

export async function sendFeedback(_userId: string, body: string) {
  const id = uuidv7();
  await data('profile-feedback', { id, body }, { idempotencyKey: id });
}
