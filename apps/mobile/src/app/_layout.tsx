import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import '../i18n';
import { AtkinsonHyperlegible_400Regular, AtkinsonHyperlegible_700Bold } from '@expo-google-fonts/atkinson-hyperlegible';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { Nunito_600SemiBold, Nunito_700Bold } from '@expo-google-fonts/nunito';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient } from '../api/queryClient';
import { Button, ErrorState, OverlayProvider, Text } from '../components';
import { DatabaseProvider } from '../db/DatabaseProvider';
import { startSync, useSyncStatus } from '../db/sync';
import { SessionProvider, useSession } from '../features/auth/session';
import { initSentry } from '../lib/sentry';
import { setupNotificationChannels } from '../platform/notifications';
import { useUiStore } from '../stores/ui';
import { t } from '../i18n';
import { ThemeProvider, useTheme } from '../theme';

initSentry();
void SplashScreen.preventAutoHideAsync();

export const unstable_settings = { initialRouteName: '(tabs)' };

/** Per-route-group fallback: friendly PT-BR + retry; runners persist progress (mobile-app.md §15). */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <ThemeProvider>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <ErrorState message={t('error.boundary')} onRetry={retry} />
      </View>
    </ThemeProvider>
  );
}

function AuthGate() {
  const { session, profile, ready } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const sync = useSyncStatus();

  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const group = segments[0];
    const inAuth = group === '(auth)';
    // Public links (shared quiz, Turma preview) still need an account to act on them.
    if (!session) {
      if (!inAuth) router.replace('/sign-in');
      return;
    }
    if (!profile) {
      if (!inAuth || segments[1] !== 'onboarding') router.replace('/onboarding/invite');
      return;
    }
    if (inAuth && !(segments[1] === 'onboarding' && (segments[2] === 'guardian' || segments[2] === 'intent' || segments[2] === 'first-subject'))) {
      router.replace('/today');
    }
  }, [ready, session, profile, segments, router]);

  useEffect(() => {
    if (!session || !profile) return;
    void setupNotificationChannels();
    return startSync();
  }, [session, profile]);

  if (sync.updateRequired) return <UpdateRequired />;
  return null;
}

/** S-SYS-01 — blocks builds below min_supported_version; unsynced reviews stay on the phone (PLT-06.3). */
function UpdateRequired() {
  const { colors } = useTheme();
  return (
    <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.bg, justifyContent: 'center', padding: 24, gap: 16 }}>
      <Text variant="title" align="center">
        {t('update.required')}
      </Text>
      <Button label={t('update.install')} onPress={() => undefined} />
    </View>
  );
}

function Themed({ children }: { children: React.ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  const easyReading = useUiStore((s) => s.easyReading);
  const highContrast = useUiStore((s) => s.highContrast);
  const reduceMotion = useUiStore((s) => s.reduceMotion);
  return (
    <ThemeProvider preference={theme} easyReading={easyReading} highContrast={highContrast} reduceMotion={reduceMotion}>
      {children}
    </ThemeProvider>
  );
}

function Navigator() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="tutor/[threadId]" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="session/[sessionId]" options={{ animation: 'fade', gestureEnabled: false }} />
      </Stack>
      <AuthGate />
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Nunito_600SemiBold,
    Nunito_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    AtkinsonHyperlegible_400Regular,
    AtkinsonHyperlegible_700Bold,
  });
  if (!fontsLoaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Themed>
            <DatabaseProvider fallback={null}>
              <OverlayProvider>
                <SessionProvider>
                  <Navigator />
                </SessionProvider>
              </OverlayProvider>
            </DatabaseProvider>
          </Themed>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
