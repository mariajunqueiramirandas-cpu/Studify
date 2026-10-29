// admin-settings-control (web dashboard, Administração → Configurações and Convites; api.md §4.11). Sets the AI
// limits (applied to the open periods at once), creates or changes a feature flag, marks an app version as the
// minimum (older builds see the blocking update screen), and creates or revokes pilot invites (SP-02, spec 00
// §8.2: single use and 14 days unless the owner picks otherwise). Every change is written to the audit log.
import { AdminSettingsControlReqSchema, ApiFailure, type AdminSettingsControlReq, type AdminSettings } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { audit, inviteLink, loadAdminSettings, newInviteCode } from '../shared/dashboard.ts';

const ZERO = '00000000-0000-0000-0000-000000000000';
const LIMIT_SCOPES = [
  ['user_day_micro_usd', 'user'],
  ['class_group_month_micro_usd', 'class_group'],
  ['global_month_micro_usd', 'global'],
] as const;

export const handler = defineP2<AdminSettingsControlReq>({
  name: 'admin-settings-control',
  mutating: true,
  input: AdminSettingsControlReqSchema,
  run: async (ctx) => {
    const { db } = ctx.deps;
    const input = ctx.input;
    const actor = ctx.user.userId;
    await requireAppAdmin(db, actor);
    let invite: AdminSettings['invites'][number] | undefined;

    switch (input.action) {
      case 'set_limits': {
        const changed: Record<string, number | null> = {};
        for (const [field, scope] of LIMIT_SCOPES) {
          const value = input[field];
          if (value === undefined) continue;
          const { error } = await db.schema('private').rpc('ai_budget_set_limit', { p_scope_type: scope, p_scope_id: ZERO, p_limit: value, p_actor: actor });
          if (error) throw error;
          changed[field] = value;
        }
        if (Object.keys(changed).length === 0) throw new ApiFailure('invalid_request', { message: 'Nada pra mudar.' });
        await audit(db, actor, 'settings.set_limits', 'settings', null, changed);
        break;
      }
      case 'flag_upsert': {
        const row: Record<string, unknown> = { key: input.key };
        if (input.description !== undefined) row.description = input.description;
        if (input.enabled_all !== undefined) row.enabled_all = input.enabled_all;
        if (input.percentage !== undefined) row.percentage = input.percentage;
        const { error } = await db.from('feature_flags').upsert(row, { onConflict: 'key' });
        if (error) throw error;
        const { key: _key, ...details } = row;
        await audit(db, actor, 'flag.upsert', 'feature_flag', input.key, details);
        break;
      }
      case 'version_block': {
        const res = await db.from('app_versions').update({ blocks_older: input.blocks_older }).eq('version_code', input.version_code).select('version_code');
        if (res.error) throw res.error;
        if (((res.data as unknown[] | null) ?? []).length === 0) throw new ApiFailure('not_found');
        await audit(db, actor, 'version.block', 'app_version', String(input.version_code), { blocks_older: input.blocks_older });
        break;
      }
      case 'invite_create': {
        const expiresAt = new Date(ctx.now.getTime() + input.expires_in_days * 86_400_000).toISOString();
        for (let attempt = 0; !invite; attempt++) {
          const row = {
            id: ctx.deps.newId(),
            code: newInviteCode(ctx.p2.randomBytes),
            created_by: actor,
            class_group_id: null,
            email: input.email ?? null,
            uses_left: input.uses,
            expires_at: expiresAt,
          };
          const res = await db.from('invites').insert(row);
          if (!res.error) {
            invite = { id: row.id, code: row.code, email: row.email, uses_left: row.uses_left, expires_at: expiresAt, revoked_at: null, created_at: ctx.now.toISOString(), link: inviteLink(ctx.p2.baseUrl, row.code) };
          } else if (res.error.code !== '23505' || attempt >= 4) {
            throw res.error;
          }
        }
        await audit(db, actor, 'invite.create', 'invite', invite.id, { uses: input.uses, expires_in_days: input.expires_in_days, bound_to_email: input.email != null });
        break;
      }
      case 'invite_revoke': {
        const res = await db
          .from('invites')
          .update({ revoked_at: ctx.now.toISOString() })
          .eq('id', input.invite_id)
          .is('class_group_id', null)
          .is('revoked_at', null)
          .select('id');
        if (res.error) throw res.error;
        if (((res.data as unknown[] | null) ?? []).length === 0) throw new ApiFailure('not_found');
        await audit(db, actor, 'invite.revoke', 'invite', input.invite_id);
        break;
      }
    }
    const settings = await loadAdminSettings(db, ctx.p2.baseUrl);
    return ctx.json(invite ? { settings, invite } : { settings });
  },
});

export default handler;
