// Push token registration (PLT-05.6). The worker pushes to every active token of a user (push_tokens); one
// active row per install (unique (user_id, device_id) where not invalidated). Without a Firebase project
// (no google-services.json) Android cannot get a token: registration is skipped quietly and the app still
// shows local notifications and the Central de notificações.
import Constants from 'expo-constants';
import { addPushTokenListener, getExpoPushTokenAsync, getPermissionsAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from '../../api/supabase';
import { getDeviceId } from '../../lib/device';
import { logger } from '../../lib/logger';

export type TokenOutcome = 'registered' | 'unchanged' | 'no_permission' | 'unavailable';

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId ?? null;
}

async function save(userId: string, token: string): Promise<TokenOutcome> {
  const deviceId = getDeviceId();
  const appVersion = Constants.expoConfig?.version ?? null;
  const { data: current } = await supabase
    .from('push_tokens')
    .select('id, token')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .is('invalidated_at', null)
    .maybeSingle();
  const row = current as { id: string; token: string } | null;
  if (row?.token === token) {
    await supabase.from('push_tokens').update({ last_seen_at: new Date().toISOString(), app_version: appVersion }).eq('id', row.id);
    return 'unchanged';
  }
  if (row) await supabase.from('push_tokens').update({ invalidated_at: new Date().toISOString() }).eq('id', row.id);
  const { error } = await supabase.from('push_tokens').insert({ user_id: userId, token, device_id: deviceId, platform: 'android', app_version: appVersion });
  if (error) {
    logger.warn('push_token.insert_failed', { code: error.code });
    return 'unavailable';
  }
  return 'registered';
}

/** Registers this install's Expo push token. Call after sign-in and after the permission is granted. */
export async function registerPushToken(userId: string): Promise<TokenOutcome> {
  if (Platform.OS !== 'android') return 'unavailable';
  const perm = await getPermissionsAsync().catch(() => null);
  if (!perm?.granted) return 'no_permission';
  const id = projectId();
  if (!id) return 'unavailable';
  try {
    const { data } = await getExpoPushTokenAsync({ projectId: id });
    return await save(userId, data);
  } catch (e) {
    // Most often: no Firebase project configured in this build.
    logger.warn('push_token.unavailable', { error: String(e) });
    return 'unavailable';
  }
}

/** FCM rotates tokens now and then; re-register when it does. Returns the unsubscribe function. */
export function watchPushToken(userId: string): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  const sub = addPushTokenListener(() => void registerPushToken(userId));
  return () => sub.remove();
}

/** Sign-out: this install stops receiving the user's pushes (security §9). */
export async function invalidatePushToken(userId: string): Promise<void> {
  await supabase
    .from('push_tokens')
    .update({ invalidated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('device_id', getDeviceId())
    .is('invalidated_at', null)
    .then(
      () => undefined,
      () => undefined,
    );
}
