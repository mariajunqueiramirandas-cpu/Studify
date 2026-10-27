// Logger: console in development; in production only warnings and errors, with data scrubbed.
import { scrubValue } from './pii';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, message: string, data?: unknown): void {
  const safe = data === undefined ? '' : ` ${JSON.stringify(scrubValue(data))}`;
  const line = `[studify:${level}] ${message}${safe}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (__DEV__) console.log(line);
}

export const logger = {
  debug: (message: string, data?: unknown) => write('debug', message, data),
  info: (message: string, data?: unknown) => write('info', message, data),
  warn: (message: string, data?: unknown) => write('warn', message, data),
  error: (message: string, data?: unknown) => write('error', message, data),
};
