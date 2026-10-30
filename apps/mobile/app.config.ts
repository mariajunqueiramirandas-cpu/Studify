import type { ConfigContext, ExpoConfig } from 'expo/config';

// mobile-app.md §17: one config, three environments (development / preview / production).
const ENV = (process.env.EXPO_PUBLIC_ENV ?? 'development') as 'development' | 'preview' | 'production';
// D-05 (2026-10-27): public links live on studify.vendua.com.br (override with EXPO_PUBLIC_BASE_URL).
// Verified App Links need https://<host>/.well-known/assetlinks.json listing this build's signing key.
const BASE_URL = process.env.EXPO_PUBLIC_BASE_URL || 'https://studify.vendua.com.br';
const appLinkHost = new URL(BASE_URL).host;

const nameSuffix = ENV === 'production' ? '' : ENV === 'preview' ? ' (prévia)' : ' (dev)';
const packageSuffix = ENV === 'production' ? '' : `.${ENV}`;

// Android build numbering. The GitHub release workflow (.github/workflows/android-release.yml) builds every
// app-changing push to main and sets APP_BUILD_NUMBER to its run number, ANDROID_VERSION_CODE to run_number + offset,
// and may set APP_VERSION_SUFFIX (e.g. "-beta.1"). The version name is BASE_VERSION.<build>, so every release has a
// new one without a commit: 0.2.57, 0.2.58, ... Raise BASE_VERSION by hand for a milestone (0.3, 1.0).
// A local build without these is BASE_VERSION.0 and keeps Expo's default versionCode.
const BASE_VERSION = '0.2';
const APP_VERSION_SUFFIX = process.env.APP_VERSION_SUFFIX ?? '';

function parseBuildNumber(raw: string | undefined): number {
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) throw new Error(`APP_BUILD_NUMBER must be a whole number, got "${raw}".`);
  return Number(raw);
}
const APP_BUILD_NUMBER = parseBuildNumber(process.env.APP_BUILD_NUMBER);

function parseVersionCode(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  // Google Play accepts versionCode values from 1 to 2100000000.
  if (!/^\d+$/.test(raw) || value < 1 || value > 2_100_000_000) {
    throw new Error(`ANDROID_VERSION_CODE must be an integer from 1 to 2100000000, got "${raw}".`);
  }
  return value;
}
const ANDROID_VERSION_CODE = parseVersionCode(process.env.ANDROID_VERSION_CODE);

// Remote push (PLT-05) needs a Firebase project: GOOGLE_SERVICES_FILE points at its google-services.json
// (the release workflow writes it from the GOOGLE_SERVICES_JSON_BASE64 secret; RELEASING.md). Without it the
// app still shows local notifications and the in-app Central de notificações, but no push reaches Android.
const GOOGLE_SERVICES_FILE = process.env.GOOGLE_SERVICES_FILE || undefined;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `Studify${nameSuffix}`,
  slug: 'studify',
  scheme: 'studify',
  version: `${BASE_VERSION}.${APP_BUILD_NUMBER}${APP_VERSION_SUFFIX}`,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  runtimeVersion: { policy: 'fingerprint' },
  updates: process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    ? { url: `https://u.expo.dev/${process.env.EXPO_PUBLIC_EAS_PROJECT_ID}` }
    : undefined,
  ios: { bundleIdentifier: `com.studify.app${packageSuffix}`, supportsTablet: false },
  android: {
    package: `com.studify.app${packageSuffix}`,
    versionCode: ANDROID_VERSION_CODE,
    ...(GOOGLE_SERVICES_FILE ? { googleServicesFile: GOOGLE_SERVICES_FILE } : {}),
    adaptiveIcon: {
      backgroundColor: '#4F46E5',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // mobile-app.md §16: request only what each phase needs; no broad storage, no exact alarms.
    // RECORD_AUDIO: voice questions to the tutor, the podcast ✋ and Ensine o Lucas (TUT-06, WEL-04), asked on first use.
    // Phase 5: READ/WRITE_CALENDAR come from the expo-calendar plugin (GOL-09, opt-in). The local focus module
    // (modules/studify-focus) declares its foreground service, Não perturbe access, usage access and overlay
    // permissions (WEL-01/02); the special-access ones are granted by the student in system settings.
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'POST_NOTIFICATIONS', 'RECEIVE_BOOT_COMPLETED', 'VIBRATE', 'CAMERA', 'RECORD_AUDIO'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.SCHEDULE_EXACT_ALARM',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: ['/c', '/i', '/q', '/b'].map((pathPrefix) => ({ scheme: 'https', host: appLinkHost, pathPrefix })),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    'expo-sqlite',
    'expo-secure-store',
    'react-native-blob-util',
    'expo-image',
    'expo-localization',
    'expo-font',
    ['expo-splash-screen', { backgroundColor: '#EFF0E7', image: './assets/splash-icon.png', imageWidth: 160, dark: { backgroundColor: '#16162A' } }],
    'expo-web-browser',
    '@react-native-google-signin/google-signin',
    'expo-sharing',
    // ING-01.3: PDFs shared from WhatsApp/Drive land on "Salvar em qual matéria?". Android only for now.
    ['expo-share-intent', { androidIntentFilters: ['application/pdf'], disableIOS: true }],
    'expo-background-task',
    ['expo-notifications', { color: '#4F46E5', defaultChannel: 'reviews' }],
    ['expo-camera', { cameraPermission: 'Para fotografar páginas, exercícios e suas respostas escritas à mão. As fotos ficam só com você, a menos que você compartilhe.', recordAudioAndroid: false }],
    // INT-01 podcast: background playback with lock-screen controls (mobile-app.md §10, decided at Phase 3).
    ['expo-audio', { recordAudioAndroid: false, enableBackgroundPlayback: true }],
    // GOL-09 calendar sync (opt-in): busy calendars are read on the phone; only free minutes per day leave it.
    ['expo-calendar', { calendarPermission: 'Para ver seus horários ocupados e colocar provas e blocos de estudo na agenda "Studify". Os títulos dos seus compromissos não saem do celular.' }],
    // TUT-06 / WEL-04 voice input: Android's on-device speech recognizer.
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Para você fazer perguntas falando. O Studify não guarda o áudio.',
        speechRecognitionPermission: 'Para transformar sua fala em texto.',
        androidSpeechServicePackages: ['com.google.android.googlequicksearchbox', 'com.google.android.tts'],
      },
    ],
    [
      'react-native-android-widget',
      {
        // MEM-04.1: "Revisão rápida", resizable between 2×2 and 4×2 (the view goes compact under 200 dp).
        widgets: [
          {
            name: 'ReviewWidget',
            label: 'Revisão rápida',
            description: 'Revise um cartão direto da tela inicial',
            minWidth: '110dp',
            minHeight: '110dp',
            targetCellWidth: 4,
            targetCellHeight: 2,
            resizeMode: 'horizontal|vertical',
            previewImage: './assets/icon.png',
            updatePeriodMillis: 1800000,
          },
        ],
      },
    ],
  ],
  experiments: { typedRoutes: true },
  // eas.projectId is required for Expo push tokens.
  extra: { env: ENV, baseUrl: BASE_URL ?? null, eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || undefined } },
});
