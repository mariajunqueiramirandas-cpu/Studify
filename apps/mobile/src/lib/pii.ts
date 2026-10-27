// PII scrubbing for error reporting (mobile-app.md §15). Pure functions so they are unit-tested.
// Rules: strip emails and display names; drop note/card/question/tutor text and file names by key;
// redact anything that looks like an email inside free text. No session replay, no request bodies.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose values are user content and must never leave the device. Matched case-insensitively. */
const SENSITIVE_KEYS = new Set(
  [
    'email',
    'e-mail',
    'display_name',
    'displayname',
    'name',
    'full_name',
    'username',
    'front',
    'back',
    'body',
    'stem',
    'text',
    'content',
    'definition',
    'example',
    'quote',
    'cited_text',
    'citedtext',
    'message',
    'user_note',
    'usernote',
    'prompt',
    'response',
    'transcript',
    'filename',
    'file_name',
    'filepath',
    'path',
    'storage_path',
    'uri',
    'url',
    'title',
    'note',
    'notes',
    'answer',
    'answers',
    'payload',
    'phone',
    'ip_address',
    'ip',
  ].map((k) => k.toLowerCase()),
);

export const REDACTED = '[redacted]';

export function scrubString(value: string): string {
  return value.replace(EMAIL, REDACTED);
}

/** Deep-copies `value`, redacting sensitive keys and emails inside strings. Depth-limited. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

interface SentryEventLike {
  user?: unknown;
  request?: unknown;
  breadcrumbs?: { values?: unknown[] } | unknown[];
  extra?: unknown;
  contexts?: unknown;
  tags?: unknown;
  message?: unknown;
  exception?: { values?: { value?: unknown; [k: string]: unknown }[] };
  [k: string]: unknown;
}

/** `beforeSend` for Sentry: removes user identity, request bodies and user content. */
export function scrubSentryEvent<T extends SentryEventLike>(event: T): T {
  const copy: SentryEventLike = { ...event };
  delete copy.user;
  delete copy.request;
  if (typeof copy.message === 'string') copy.message = scrubString(copy.message);
  copy.extra = scrubValue(copy.extra);
  copy.contexts = scrubValue(copy.contexts);
  copy.tags = scrubValue(copy.tags);
  if (copy.exception?.values) {
    copy.exception = {
      ...copy.exception,
      values: copy.exception.values.map((v) => ({
        ...v,
        value: typeof v.value === 'string' ? scrubString(v.value) : v.value,
      })),
    };
  }
  if (copy.breadcrumbs) {
    const list = Array.isArray(copy.breadcrumbs) ? copy.breadcrumbs : (copy.breadcrumbs.values ?? []);
    const scrubbed = list.map((b) => scrubBreadcrumb(b));
    copy.breadcrumbs = Array.isArray(copy.breadcrumbs) ? scrubbed : { ...copy.breadcrumbs, values: scrubbed };
  }
  return copy as T;
}

export function scrubBreadcrumb<T>(breadcrumb: T): T {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const b = breadcrumb as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };
  // Navigation paths can contain ids and deep-link params; keep the category, drop the data.
  delete out['data'];
  if (typeof out['message'] === 'string') out['message'] = scrubString(out['message']);
  return out as T;
}
