// signup-complete (PLT-02.2–7, SP-01–03). Runs once after the first sign-in. The auth hook has only
// checked the invite's syntax; this function does the real checks: the age gate, the invite's state, the
// profile row and the Turma join (which runs as the student so auth.uid() is set, see join_class_group).
// Not idempotent by key: the profile row does not exist until this call creates it, and the
// idempotency table references profiles. A second call answers already_completed.
import { z } from 'zod';
import { ApiFailure, SignupCompleteReqSchema, type SignupCompleteRes, DEFAULT_TIME_ZONE, wallClockOf } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';

/** Display names with a blocklist hit are rejected before any row is written (SP-11, owner list pending). */
export const BLOCKED_NAME_FRAGMENTS = ['studify', 'admin', 'suporte', 'moderador'];
const MIN_AGE = 12;

/**
 * Bootstrap invite (SP-02): sign-up needs an invite and only an app_admin can issue pilot invites, so
 * the very first account redeems this code and becomes the owner. It works only while no app_admin
 * exists; afterwards it answers invite_invalid like any unknown code.
 */
export const BOOTSTRAP_INVITE_CODE = 'STUDYF26';

interface InviteRow {
  id: string;
  class_group_id: string | null;
  uses_left: number | null;
  expires_at: string;
  revoked_at: string | null;
  email: string | null;
}

/** Whole years at `now` in the student's default zone, from birth month and year (SP-01 age gate). */
export function ageAt(now: Date, birthYear: number, birthMonth: number): number {
  const [year, month] = wallClockOf(now, DEFAULT_TIME_ZONE).date.split('-').map(Number) as [number, number, number];
  let age = year - birthYear;
  if (month < birthMonth) age -= 1;
  return age;
}

export const handler = defineFunction<z.infer<typeof SignupCompleteReqSchema>>({
  name: 'signup-complete',
  mutating: false,
  input: SignupCompleteReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const req = ctx.input;
    const userId = ctx.user.userId;

    const existing = await db.from('profiles').select('id').eq('id', userId).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) throw new ApiFailure('already_completed');

    const age = ageAt(ctx.now, req.birth_year, req.birth_month);
    if (age < MIN_AGE) {
      // No data is stored for a student under the age gate; the auth user is removed (api §4.1).
      await db.auth.admin.deleteUser(userId);
      throw new ApiFailure('under_age');
    }

    const name = req.display_name.toLowerCase();
    if (BLOCKED_NAME_FRAGMENTS.some((fragment) => name.includes(fragment))) {
      throw new ApiFailure('display_name_rejected');
    }

    let bootstrap = false;
    if (req.invite_code === BOOTSTRAP_INVITE_CODE) {
      const admin = await db.from('profiles').select('id').eq('app_role', 'app_admin').limit(1).maybeSingle();
      if (admin.error) throw admin.error;
      bootstrap = !admin.data;
    }

    let row: InviteRow | null = null;
    if (!bootstrap) {
      const invite = await db
        .from('invites')
        .select('id, class_group_id, uses_left, expires_at, revoked_at, email')
        .eq('code', req.invite_code)
        .maybeSingle();
      if (invite.error) throw invite.error;
      row = invite.data as InviteRow | null;
      if (!row || row.revoked_at) throw new ApiFailure('invite_invalid');
      if (new Date(row.expires_at).getTime() <= ctx.now.getTime()) throw new ApiFailure('invite_expired');
      if (row.uses_left !== null && row.uses_left <= 0) throw new ApiFailure('invite_used_up');
      if (row.email && ctx.user.email && row.email.toLowerCase() !== ctx.user.email.toLowerCase()) {
        throw new ApiFailure('invite_invalid');
      }
    }

    const created = await db.from('profiles').insert({
      id: userId,
      display_name: req.display_name,
      avatar_preset: req.avatar_preset ?? null,
      birth_year: req.birth_year,
      birth_month: req.birth_month,
      school_year: req.school_year,
      privacy_notice_version: req.privacy_notice_version,
      privacy_accepted_at: ctx.now.toISOString(),
      invite_id: row?.id ?? null,
      ...(bootstrap ? { app_role: 'app_admin' } : {}),
    });
    if (created.error) {
      if (created.error.code === '23505') throw new ApiFailure('already_completed');
      throw created.error;
    }

    let classGroup: SignupCompleteRes['class_group'];
    try {
      // The bootstrap owner has no invite row (row is null): nothing to join or use up.
      if (row?.class_group_id) {
        // join_class_group reads auth.uid(), so it runs with the student's own token.
        const joined = await ctx.deps.asUser(ctx.user).rpc('join_class_group', { p_code: req.invite_code });
        if (joined.error) throw joined.error;
        const payload = joined.data as { class_group_id: string; status: 'active' | 'pending' };
        const group = await db.from('class_groups').select('name').eq('id', payload.class_group_id).maybeSingle();
        classGroup = { id: payload.class_group_id, name: (group.data?.name as string) ?? '', status: payload.status };
      } else if (row && row.uses_left !== null) {
        const used = await db
          .from('invites')
          .update({ uses_left: row.uses_left - 1 })
          .eq('id', row.id)
          .gt('uses_left', 0);
        if (used.error) throw used.error;
      }
    } catch (err) {
      // Keep the sign-up retryable: remove the profile row when the join fails.
      await db.from('profiles').delete().eq('id', userId);
      throw err;
    }

    const body: SignupCompleteRes = {
      profile_id: userId,
      guardian_required: false, // SP-03 guardian links are Phase 2 (under 16 → true then)
      ...(classGroup ? { class_group: classGroup } : {}),
    };
    return ctx.json(body);
  },
});

export default handler;
