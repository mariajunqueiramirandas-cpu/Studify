import { GoogleSignin, isErrorWithCode, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { supabase } from '../../api/supabase';
import { logger } from '../../lib/logger';

const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
let configured = false;

// Android's DEVELOPER_ERROR: no Android OAuth client in the web client's Google Cloud project matches this
// build's package name and signing SHA-1 (RELEASING.md §7).
const DEVELOPER_ERROR = '10';

/** What went wrong, so the sign-in screen can say something more useful than "try again". */
export type GoogleSignInFailure = 'cancelled' | 'misconfigured' | 'play_services' | 'failed';

export function googleAvailable(): boolean {
  return !!webClientId;
}

/** Maps an error thrown by `signInWithGoogle` to what the screen shows, and logs the code for Sentry. */
export function classifyGoogleError(error: unknown): GoogleSignInFailure {
  if (isErrorWithCode(error)) {
    const code = String(error.code);
    if (code === statusCodes.SIGN_IN_CANCELLED || code === statusCodes.IN_PROGRESS) return 'cancelled';
    logger.error('google sign-in failed', { code, message: error.message });
    if (code === DEVELOPER_ERROR) return 'misconfigured';
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) return 'play_services';
    return 'failed';
  }
  logger.error('google sign-in failed', { message: error instanceof Error ? error.message : String(error) });
  return 'failed';
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
