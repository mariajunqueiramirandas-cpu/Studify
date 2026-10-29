// account-update (web dashboard, Minha conta; api.md §4.11). Edits the profile (name, school year, timezone,
// ENEM language), the app preferences (theme, notification channels) and the quiet hours, then answers the fresh
// overview. The service role bypasses the profiles_display_name_guard trigger, so a new name is sent back to
// moderation here (SP-11), and the under-18 quiet-hours rule (PLT-05.3) is checked before the database trigger.
import { AccountUpdateReqSchema, ApiFailure, DEFAULT_TIME_ZONE, localDateOf, type AccountUpdateReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { isMinorBirth, isTimeZone, loadAccountOverview, quietMinutes, requireProfile } from '../shared/dashboard.ts';
import { BLOCKED_NAME_FRAGMENTS } from './signup-complete.ts';

const MIN_MINOR_QUIET_MINUTES = 8 * 60;

export const handler = defineFunction<AccountUpdateReq>({
  name: 'account-update',
  mutating: true,
  input: AccountUpdateReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    const userId = ctx.user.userId;
    const profile = await requireProfile(db, userId);

    const patch: Record<string, unknown> = {};
    if (input.display_name !== undefined && input.display_name !== profile.display_name) {
      const lower = input.display_name.toLowerCase();
      if (BLOCKED_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment))) throw new ApiFailure('display_name_rejected');
      patch.display_name = input.display_name;
      patch.display_name_status = 'pending';
    }
    if (input.school_year !== undefined) patch.school_year = input.school_year;
    if (input.foreign_language !== undefined) patch.foreign_language = input.foreign_language;
    if (input.timezone !== undefined) {
      if (!isTimeZone(input.timezone)) throw new ApiFailure('invalid_request', { message: 'Fuso horário desconhecido.' });
      patch.timezone = input.timezone;
    }
    if (input.theme !== undefined || input.notifications !== undefined) {
      const settings = { ...(profile.settings ?? {}) };
      if (input.theme !== undefined) settings.theme = input.theme;
      if (input.notifications !== undefined) {
        settings.notifications = { ...((settings.notifications as Record<string, boolean> | undefined) ?? {}), ...input.notifications };
      }
      patch.settings = settings;
    }

    let quiet: { quiet_start: string; quiet_end: string } | null = null;
    if (input.quiet_start !== undefined || input.quiet_end !== undefined) {
      const current = await db.from('study_preferences').select('quiet_start, quiet_end').eq('user_id', userId).maybeSingle();
      if (current.error) throw current.error;
      const row = current.data as { quiet_start?: string; quiet_end?: string } | null;
      quiet = {
        quiet_start: input.quiet_start ?? row?.quiet_start?.slice(0, 5) ?? '22:00',
        quiet_end: input.quiet_end ?? row?.quiet_end?.slice(0, 5) ?? '07:00',
      };
      const minor = isMinorBirth(profile.birth_year, profile.birth_month, localDateOf(ctx.now, DEFAULT_TIME_ZONE));
      if (minor && quietMinutes(quiet.quiet_start, quiet.quiet_end) < MIN_MINOR_QUIET_MINUTES) {
        throw new ApiFailure('invalid_request', { message: 'Para quem tem menos de 18 anos, o horário silencioso tem pelo menos 8 horas.' });
      }
    }

    if (Object.keys(patch).length > 0) {
      const res = await db.from('profiles').update(patch).eq('id', userId);
      if (res.error) throw res.error;
    }
    if (quiet) {
      const res = await db.from('study_preferences').upsert({ user_id: userId, ...quiet }, { onConflict: 'user_id' });
      if (res.error) throw res.error;
    }
    return ctx.json(await loadAccountOverview(ctx.deps, ctx.user, ctx.now));
  },
});

export default handler;
