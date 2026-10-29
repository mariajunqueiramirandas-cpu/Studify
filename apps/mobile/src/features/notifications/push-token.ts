// Push token registration (PLT-05.6). The worker pushes to every active token of a user (push_tokens); one
// active row per install (unique (user_id, device_id) where not invalidated). Without a Firebase project
// (no google-services.json) Android cannot get a token: registration is skipped quietly and the app still
// shows local notifications and the Central de notificações.
import Constants from 'expo-constants';
import { addPushTokenListener, getExpoPushTokenAsync, getPermissionsAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import { data } from '../../api/data';
import { ApiError } from '../../api/errors';
import { getDeviceId } from '../../lib/device';
import { logger } from '../../lib/logger';

export type TokenOutcome = 'registered' | 'unchanged' | 'no_permission' | 'unavailable';

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId ?? null;
}

async function save(token: string): Promise<TokenOutcome> {
  const appVersion = Constants.expoConfig?.version ?? null;
  try {
    const res = await data<{ outcome: 'registered' | 'unchanged' }>('push-token-save', { token, device_id: getDeviceId(), app_version: appVersion });
    return res.outcome;
  } catch (e) {
    logger.warn('push_token.insert_failed', { code: e instanceof ApiError ? e.code : String(e) });
    return 'unavailable';
  }
}

/** Registers this install's Expo push token. Call after sign-in and after the permission is granted. */
export async function registerPushToken(userId: string): Promise<TokenOutcome> {
  if (Platform.OS !== 'android') return 'unavailable';
  const perm = await getPermissionsAsync().catch(() => null);
  if (!perm?.granted) return 'no_permission';
  const id = projectId();
  if (!id) return 'unavailable';
  try {
    const { data: token } = await getExpoPushTokenAsync({ projectId: id });
    return await save(token);
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
export async function invalidatePushToken(_userId: string): Promise<void> {
  await data('push-token-invalidate', { device_id: getDeviceId() }).then(
    () => undefined,
    () => undefined,
  );
}
