import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
import { supabase } from '../../api/supabase';

const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
let configured = false;

export function googleAvailable(): boolean {
  return !!webClientId;
}

/** Google → ID token → Supabase `signInWithIdToken` (mobile-app.md §12). */
export async function signInWithGoogle(): Promise<void> {
  if (!webClientId) throw new Error('google_not_configured');
  if (!configured) {
    GoogleSignin.configure({ webClientId, scopes: ['email'] });
    configured = true;
  }
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const res = await GoogleSignin.signIn();
  if (!isSuccessResponse(res) || !res.data.idToken) return;
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: res.data.idToken });
  if (error) throw error;
}
