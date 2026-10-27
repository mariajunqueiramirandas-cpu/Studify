import { Redirect, useLocalSearchParams } from 'expo-router';
import { normalizeInviteCode, useOnboarding } from '../../features/auth/onboarding';

/** `studify://auth/invite?code=…` (PLT-02.2) — prefill the code, then continue onboarding. */
export default function InviteLink() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  if (code) useOnboarding.getState().set({ inviteCode: normalizeInviteCode(code) });
  return <Redirect href="/onboarding/invite" />;
}
