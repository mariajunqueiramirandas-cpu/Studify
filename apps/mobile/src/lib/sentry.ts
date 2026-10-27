// Sentry (mobile-app.md §15): release = app version, errors only at 100 %, traces at 10 %, no PII.
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { setLogBreadcrumbSink } from './logger';
import { scrubBreadcrumb, scrubSentryEvent } from './pii';

declare const process: { env: Record<string, string | undefined> };

let started = false;

/** Initializes Sentry once. Disabled without a DSN or in development builds. */
export function initSentry(): void {
  if (started) return;
  started = true;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const environment = process.env.EXPO_PUBLIC_ENV ?? 'development';
  Sentry.init({
    dsn,
    enabled: !!dsn && !__DEV__,
    environment,
    release: Constants.expoConfig?.version,
    dist: String((Constants.expoConfig?.android as { versionCode?: number } | undefined)?.versionCode ?? ''),
    sendDefaultPii: false,
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  setLogBreadcrumbSink((level, message) => {
    if (level === 'warn' || level === 'error') {
      Sentry.addBreadcrumb({ level, message, category: 'studify' });
    }
  });
}

export { Sentry };
