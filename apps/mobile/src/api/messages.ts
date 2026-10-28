// The text to show when an action fails (ADR 0009, rule 4: errors say what happened). The server's error envelope
// carries a PT-BR message written for the student (api.md §2.2), and the client's own errors (offline, timeout) do
// too, so an ApiError shows its message. Anything else (a local database error, a bug) gets the generic copy.
import { t } from '../i18n';
import { ApiError } from './errors';

/** `fallback` replaces the generic copy where the screen has a better one (e.g. a failed generation). */
export function messageFor(error: unknown, fallback: string = t('error.generic')): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}
