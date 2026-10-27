// Connectivity (NetInfo). Unknown state counts as online: the sync engine simply retries.
import { useNetInfo } from '@react-native-community/netinfo';

export function isOnlineState(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** True unless the device reports no connection. Re-renders on change. */
export function useIsOnline(): boolean {
  return isOnlineState(useNetInfo());
}
