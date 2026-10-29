// Which app builds the API still serves (api.md §2.1). The app sends CLIENT_COMPAT_LEVEL in `x-studify-compat` on
// every call; the API answers 426 `app_update_required` to an app below it, and the app then shows its "update"
// screen, whose button opens /download (the newest release APK). Builds made before this header existed send none
// and count as level 1.
//
// Raise it, in the same change, whenever older apps can no longer work with the API: every app below the new level
// is asked to update the moment the API is deployed; nobody has to register versions by hand.
//   2: data, files and realtime moved to the API (ADR 0012); older builds still query Supabase's tables.
export const CLIENT_COMPAT_LEVEL = 2;

/** The header that carries it. */
export const CLIENT_COMPAT_HEADER = 'x-studify-compat';

/**
 * True when the API serves this request's app. Only the Android app sends `x-studify-version`; other callers (the
 * web dashboard) are not gated. An app without the compat header is a build from before it existed: level 1.
 */
export function isSupportedClient(headers: { get(name: string): string | null }): boolean {
  if (headers.get('x-studify-version') === null) return true;
  const raw = headers.get(CLIENT_COMPAT_HEADER);
  const level = raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
  return level >= CLIENT_COMPAT_LEVEL;
}
