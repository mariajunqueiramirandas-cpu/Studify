// Accounts stay on Supabase Auth (ADR 0012); everything else lives on Studify's own Postgres, whose auth.users
// table is a copy of the accounts the schema points at (profiles.id references it). This is db.auth: the
// supabase-js calls the API already made, plus the upkeep of that copy:
//   * a verified token (getUser) writes the account's email, last sign-in and suspension, so the first call of a
//     new student creates the row their profile needs;
//   * a suspension (updateUserById with ban_duration) copies the new banned_until at once;
//   * deleting an account deletes the row, and the foreign keys cascade from it as they did on Supabase. An
//     account Supabase no longer has counts as deleted, so a deletion that failed halfway finishes on retry.
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { AuthUserRecord, DbAuth } from '@studify/db';

type Queryable = Pick<pg.Pool, 'query'>;

export async function mirrorUser(sql: Queryable, user: AuthUserRecord): Promise<void> {
  await sql.query(
    `insert into auth.users (id, email, created_at, last_sign_in_at, banned_until)
     values ($1, $2, coalesce($3::timestamptz, now()), $4, $5)
     on conflict (id) do update set email = excluded.email, last_sign_in_at = excluded.last_sign_in_at,
       banned_until = excluded.banned_until, updated_at = now()`,
    [user.id, user.email ?? null, user.created_at ?? null, user.last_sign_in_at ?? null, user.banned_until ?? null],
  );
}

export function supabaseAuth(url: string, serviceKey: string, sql: Queryable): DbAuth {
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async getUser(jwt) {
      const res = await client.auth.getUser(jwt);
      if (!res.error && res.data.user) await mirrorUser(sql, res.data.user as unknown as AuthUserRecord);
      return res as Awaited<ReturnType<DbAuth['getUser']>>;
    },
    admin: {
      async deleteUser(id) {
        const res = await client.auth.admin.deleteUser(id);
        if (res.error && res.error.status !== 404) return res;
        await sql.query('delete from auth.users where id = $1', [id]);
        return { data: res.data ?? null, error: null };
      },
      async updateUserById(id, attributes) {
        const res = await client.auth.admin.updateUserById(id, attributes);
        if (!res.error && res.data.user) await mirrorUser(sql, res.data.user as unknown as AuthUserRecord);
        return res as Awaited<ReturnType<DbAuth['admin']['updateUserById']>>;
      },
      signOut: (jwt, scope) => client.auth.admin.signOut(jwt, scope),
    },
  };
}
