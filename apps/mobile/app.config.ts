import type { ConfigContext, ExpoConfig } from 'expo/config';

// mobile-app.md §17: one config, three environments (development / preview / production).
const ENV = (process.env.EXPO_PUBLIC_ENV ?? 'development') as 'development' | 'preview' | 'production';
// D-05: the HTTPS domain for invite links is still an open owner decision. App Links are
// only declared once EXPO_PUBLIC_BASE_URL is set; custom-scheme links work either way.
const BASE_URL = process.env.EXPO_PUBLIC_BASE_URL;
const appLinkHost = BASE_URL ? new URL(BASE_URL).host : undefined;

const nameSuffix = ENV === 'production' ? '' : ENV === 'preview' ? ' (prévia)' : ' (dev)';
const packageSuffix = ENV === 'production' ? '' : `.${ENV}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `Studify${nameSuffix}`,
  slug: 'studify',
  scheme: 'studify',
  version: '0.1.0',
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
    adaptiveIcon: {
      backgroundColor: '#4F46E5',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // mobile-app.md §16: request only what each phase needs; no broad storage, no exact alarms.
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'POST_NOTIFICATIONS', 'RECEIVE_BOOT_COMPLETED', 'VIBRATE', 'CAMERA'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.SCHEDULE_EXACT_ALARM',
      'android.permission.RECORD_AUDIO',
    ],
    intentFilters: appLinkHost
      ? [
          {
            action: 'VIEW',
            autoVerify: true,
            data: ['/c', '/i', '/q', '/b'].map((pathPrefix) => ({ scheme: 'https', host: appLinkHost, pathPrefix })),
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ]
      : [],
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
    ['expo-splash-screen', { backgroundColor: '#FFFFFF', image: './assets/splash-icon.png', imageWidth: 160, dark: { backgroundColor: '#0F1115' } }],
    'expo-web-browser',
    '@react-native-google-signin/google-signin',
    '@sentry/react-native',
    'expo-sharing',
    // ING-01.3: PDFs shared from WhatsApp/Drive land on "Salvar em qual matéria?". Android only for now.
    ['expo-share-intent', { androidIntentFilters: ['application/pdf'], disableIOS: true }],
    'expo-background-task',
    ['expo-notifications', { color: '#4F46E5', defaultChannel: 'reviews' }],
    ['expo-camera', { cameraPermission: 'Para escanear o QR da turma e tirar fotos da lista de conteúdo. As fotos ficam só com você.', recordAudioAndroid: false }],
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
  extra: { env: ENV, baseUrl: BASE_URL ?? null },
});
