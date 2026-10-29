// Structured logging with pino. Logs carry ids, task ids, stop reasons and counts only: never
// document text, prompts, responses, names or tokens (security-privacy, minors' data).
import pino, { type Logger } from 'pino';
import type { LogLevel } from './env.ts';

export type { Logger };

const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'serviceRoleKey',
  'authorization',
  'headers.authorization',
  'databaseUrl',
  'DATABASE_URL',
  'email',
  'display_name',
  'text',
  'body',
  'front',
  'back',
  'stem',
  'citations',
  'payload',
  'messages',
  'system',
  '*.email',
  '*.token',
  '*.display_name',
];

export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: 'studify-api-tasks', ...base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
