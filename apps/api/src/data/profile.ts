// Data endpoints of apps/mobile/src/features/profile, the session's profile read (features/auth/session.tsx) and the
// feature flags (lib/flags.ts). define.ts explains the contract.
import { z } from 'zod';
import { dataRoute, done, maybe, type DataRoute } from './define.ts';

const SCHOOL_YEARS = ['ef9', 'em1', 'em2', 'em3', 'cursinho', 'outro'] as const;

/** A shallow patch merged into profiles.settings (ProfileSettings, data-model §5.1). */
const SettingsPatch = z
  .record(z.string().min(1).max(64), z.unknown())
  .refine((patch) => Object.keys(patch).length <= 50, 'too many keys')
  .refine((patch) => JSON.stringify(patch).length <= 16_000, 'settings too large');

export const routes: DataRoute[] = [
  dataRoute({
    // The signed-in student's profile, or null while it does not exist yet (sign-up not completed).
    name: 'profile-get',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => maybe(db.from('profiles').select('*').eq('id', user.userId).maybeSingle()),
  }),

  dataRoute({
    // Updates profile columns and/or merges keys into profiles.settings; answers the merged settings when patched.
    name: 'profile-update',
    write: true,
    input: z.object({
      display_name: z.string().min(1).max(100).optional(),
      school_year: z.enum(SCHOOL_YEARS).optional(),
      avatar_preset: z.string().min(1).max(64).optional(),
      settings: SettingsPatch.optional(),
    }),
    example: () => ({ settings: { theme: 'system' } }),
    run: async ({ db, user, input }) => {
      const patch: Record<string, string> = {};
      if (input.display_name !== undefined) patch.display_name = input.display_name;
      if (input.school_year !== undefined) patch.school_year = input.school_year;
      if (input.avatar_preset !== undefined) patch.avatar_preset = input.avatar_preset;
      if (Object.keys(patch).length > 0) await done(db.from('profiles').update(patch).eq('id', user.userId), 'profiles.update');
      if (!input.settings) return { ok: true, settings: null };
      const current = await done<{ settings: Record<string, unknown> | null }>(db.from('profiles').select('settings').eq('id', user.userId).single(), 'profiles.settings');
      const settings = { ...(current?.settings ?? {}), ...input.settings };
      await done(db.from('profiles').update({ settings }).eq('id', user.userId), 'profiles.settings.update');
      return { ok: true, settings };
    },
  }),

  dataRoute({
    // PLT-04.2: today's AI usage as % of the limit.
    name: 'profile-ai-usage',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db }) => done(db.rpc('my_ai_usage_today'), 'my_ai_usage_today'),
  }),

  dataRoute({
    // PLT-06.5: "Ajuda" feedback. The id is the app's, so a retry never stores it twice.
    name: 'profile-feedback',
    write: true,
    input: z.object({ id: z.string().uuid(), body: z.string().min(1).max(2000) }),
    example: () => ({ id: crypto.randomUUID(), body: 'Gostei do app.' }),
    run: async ({ db, user, input }) => {
      await done(db.from('app_feedback').insert({ id: input.id, user_id: user.userId, text: input.body }), 'app_feedback.insert');
      return { ok: true };
    },
  }),

  dataRoute({
    // Server-side feature flags on for the caller (rollouts from feature_flags).
    name: 'flags-mine',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db }) => {
      const data = await done<unknown>(db.rpc('my_feature_flags'), 'my_feature_flags');
      return Array.isArray(data) ? data : [];
    },
  }),
];
