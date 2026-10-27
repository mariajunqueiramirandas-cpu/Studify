// Supabase client for the app: session in an encrypted LargeSecureStore, token refresh tied to
// the app's foreground state (mobile-app.md §12).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';
import { AppState, type AppStateStatus } from 'react-native';
import { getEnv } from './env';
import { LargeSecureStore } from './secure-session-storage';

const env = getEnv();

export const supabase: SupabaseClient = createClient(env.url, env.anonKey, {
  auth: {
    storage: LargeSecureStore,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh only while foregrounded (saves battery, avoids refresh races in the background).
function onAppStateChange(state: AppStateStatus) {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
}

let appStateSubscription: { remove: () => void } | null = null;

/** Idempotent. Called once from the root layout (or automatically on first import). */
export function startAuthAutoRefresh(): () => void {
  if (!appStateSubscription) {
    appStateSubscription = AppState.addEventListener('change', onAppStateChange);
    onAppStateChange(AppState.currentState);
  }
  return () => {
    appStateSubscription?.remove();
    appStateSubscription = null;
    supabase.auth.stopAutoRefresh();
  };
}

startAuthAutoRefresh();
