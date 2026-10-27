// Logger: console in development; in production only warnings and errors, scrubbed before they
// reach Sentry breadcrumbs (added by sentry.ts through the global hook below).
import { scrubValue } from './pii';

type Level = 'debug' | 'info' | 'warn' | 'error';

let breadcrumbSink: ((level: Level, message: string) => void) | null = null;

/** Set by sentry.ts once Sentry is initialized. */
export function setLogBreadcrumbSink(sink: ((level: Level, message: string) => void) | null): void {
  breadcrumbSink = sink;
}

function write(level: Level, message: string, data?: unknown): void {
  const safe = data === undefined ? '' : ` ${JSON.stringify(scrubValue(data))}`;
  const line = `[studify:${level}] ${message}${safe}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (__DEV__) console.log(line);
  breadcrumbSink?.(level, message);
}

export const logger = {
  debug: (message: string, data?: unknown) => write('debug', message, data),
  info: (message: string, data?: unknown) => write('info', message, data),
  warn: (message: string, data?: unknown) => write('warn', message, data),
  error: (message: string, data?: unknown) => write('error', message, data),
};
