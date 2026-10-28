// Account and retention jobs (SP-14, security-privacy §10): account.export builds a ZIP (JSON per table,
// CSV of cards) into the exports bucket; account.delete anonymizes what must outlive the account and
// removes the rest; storage.purge hard-deletes tombstones older than 30 days and expired exports.
import { z } from 'zod';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { JobDataError, chunk, fetchAll, unwrap, unwrapRows, uniq, IN_CHUNK } from '../lib/db.ts';
import { buildZip, toCsv, type ZipEntry } from '../lib/zip.ts';

const ExportPayload = z.object({ export_id: z.string().min(1) });
const DeletePayload = z.object({ deletion_id: z.string().min(1) });
const PurgePayload = z.object({}).passthrough();
const ResetFilesPayload = z.object({
  user_id: z.string().min(1),
  documents: z.array(z.object({ id: z.string().min(1), storage_path: z.string().min(1) })).max(20_000).default([]),
  exports: z.array(z.string().min(1)).max(1000).default([]),
});

export const EXPORT_TTL_MS = 7 * 24 * 3600 * 1000;
/** Tombstones older than this are hard-deleted (data-model §1.1). */
export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Tables exported for the student, with the filter that selects only their own rows. */
const EXPORT_TABLES: ReadonlyArray<{ table: string; column: string; userKey?: boolean }> = [
  { table: 'study_preferences', column: 'user_id' },
  { table: 'goals', column: 'user_id' },
  { table: 'exams', column: 'user_id' },
  { table: 'subjects', column: 'owner_profile_id' },
  { table: 'card_states', column: 'user_id' },
  { table: 'review_logs', column: 'user_id' },
  { table: 'mistakes', column: 'user_id' },
  { table: 'quiz_attempts', column: 'user_id' },
  { table: 'attempt_answers', column: 'user_id' },
  { table: 'mastery', column: 'user_id' },
  { table: 'mastery_evidence', column: 'user_id' },
  { table: 'study_sessions', column: 'user_id' },
  { table: 'tutor_threads', column: 'user_id' },
  { table: 'tutor_messages', column: 'user_id' },
  { table: 'xp_events', column: 'user_id' },
  { table: 'daily_activity', column: 'user_id' },
  { table: 'streaks', column: 'user_id' },
  { table: 'plan_items', column: 'user_id' },
  { table: 'plan_runs', column: 'user_id' },
  { table: 'trails', column: 'user_id' },
  { table: 'trail_steps', column: 'user_id' },
];

const CARD_COLUMNS = ['id', 'subject_id', 'node_id', 'type', 'front', 'back', 'origin', 'status', 'created_at', 'updated_at'];

export interface ExportManifest {
  user_id: string;
  export_id: string;
  generated_at: string;
  files: Record<string, number>;
  errors: Record<string, string>;
}

/** Reads the personal data of one user. Missing tables are recorded in the manifest instead of failing the export. */
export async function collectExport(ctx: JobContext, userId: string): Promise<{ entries: ZipEntry[]; manifest: Omit<ExportManifest, 'export_id'> }> {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const files: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const add = (name: string, rows: unknown[]): void => {
    entries.push({ name, data: encoder.encode(JSON.stringify(rows, null, 2)) });
    files[name] = rows.length;
  };

  const profile = await ctx.supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (profile.error) throw new JobDataError(`profiles: ${profile.error.message}`, 'db_error');
  const { invite_id: _invite, ...profileData } = (profile.data ?? {}) as Record<string, unknown>;
  add('profile.json', profileData ? [profileData] : []);

  for (const spec of EXPORT_TABLES) {
    try {
      const rows = await fetchAll<Record<string, unknown>>(
        (from, to) =>
          ctx.supabase.from(spec.table).select('*').eq(spec.column, userId).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
            data: Record<string, unknown>[] | null;
            error: { message: string } | null;
          }>,
        spec.table,
      );
      add(`${spec.table}.json`, rows);
    } catch (err) {
      errors[spec.table] = err instanceof Error ? err.message : String(err);
    }
  }

  // Cards the student made or personalised (CSV, as the spec asks for cards).
  try {
    const cards = await fetchAll<Record<string, unknown>>(
      (from, to) =>
        ctx.supabase.from('cards').select(CARD_COLUMNS.join(',')).eq('personal_for_user_id', userId).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        }>,
      'cards',
    );
    entries.push({ name: 'cards.csv', data: encoder.encode(toCsv(CARD_COLUMNS, cards)) });
    files['cards.csv'] = cards.length;
  } catch (err) {
    errors.cards = err instanceof Error ? err.message : String(err);
  }
  return { entries, manifest: { user_id: userId, generated_at: new Date().toISOString(), files, errors } };
}

export interface ExportOutcome {
  status: 'ready' | 'skipped';
  path?: string;
  files?: number;
  signedUrl?: string | null;
}

/** account.export (SP-14): builds the archive, uploads it and records a 7-day window. */
export async function handleAccountExport(ctx: JobContext, raw: Record<string, unknown>): Promise<ExportOutcome> {
  const payload = ExportPayload.parse(raw);
  const row = unwrap(await ctx.supabase.from('data_exports').select('id,user_id,status').eq('id', payload.export_id).maybeSingle(), 'data_exports') as {
    id: string;
    user_id: string;
    status: string;
  } | null;
  if (!row || row.status === 'ready') return { status: 'skipped' };
  unwrap(await ctx.supabase.from('data_exports').update({ status: 'running' }).eq('id', row.id), 'data_exports');
  try {
    await ctx.progress({ stage: 'collect', status: 'running', progress: 0.1 });
    const { entries, manifest } = await collectExport(ctx, row.user_id);
    entries.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ ...manifest, export_id: row.id }, null, 2)) });
    const zip = buildZip(entries);
    await ctx.progress({ stage: 'upload', status: 'running', progress: 0.8 });
    const path = `${row.user_id}/${row.id}.zip`;
    const upload = await ctx.supabase.storage.from('exports').upload(path, zip, { contentType: 'application/zip', upsert: true });
    if (upload.error) throw new JobDataError(`exports upload: ${upload.error.message}`, 'storage');
    const now = ctx.now();
    unwrap(
      await ctx.supabase
        .from('data_exports')
        .update({ status: 'ready', storage_path: path, expires_at: new Date(now.getTime() + EXPORT_TTL_MS).toISOString(), completed_at: now.toISOString() })
        .eq('id', row.id),
      'data_exports',
    );
    await ctx.enqueue('notify.dispatch', { user_id: row.user_id, type: 'export_ready', data: { export_id: row.id } }, { singletonKey: `export_ready:${row.id}` });
    // The link is handed out for the download window only; it is not stored (the row keeps the path).
    const signed = await ctx.supabase.storage.from('exports').createSignedUrl(path, Math.floor(EXPORT_TTL_MS / 1000));
    await ctx.progress({ stage: 'done', status: 'succeeded', progress: 1 });
    return { status: 'ready', path, files: Object.keys(manifest.files).length, signedUrl: signed.data?.signedUrl ?? null };
  } catch (err) {
    unwrap(await ctx.supabase.from('data_exports').update({ status: 'failed' }).eq('id', row.id), 'data_exports');
    throw err;
  }
}

export interface DeleteOutcome {
  status: 'done' | 'blocked' | 'skipped';
  reason?: string;
}

/**
 * account.delete (SP-14): anonymizes ai_usage, keeps shared uploads as "ex-membro" unless the student
 * asked to delete them, then removes the auth user (profile and personal rows cascade). A student who
 * still owns a Turma must transfer ownership first, so that case is reported as blocked.
 */
export async function handleAccountDelete(ctx: JobContext, raw: Record<string, unknown>): Promise<DeleteOutcome> {
  const payload = DeletePayload.parse(raw);
  const row = unwrap(
    await ctx.supabase.from('account_deletions').select('id,user_id,delete_shared_uploads,status').eq('id', payload.deletion_id).maybeSingle(),
    'account_deletions',
  ) as { id: string; user_id: string; delete_shared_uploads: boolean; status: string } | null;
  if (!row || row.status === 'done') return { status: 'skipped' };
  const owned = unwrapRows<{ id: string }>(await ctx.supabase.from('class_groups').select('id').eq('owner_id', row.user_id).is('deleted_at', null), 'class_groups');
  if (owned.length > 0) {
    unwrap(await ctx.supabase.from('account_deletions').update({ status: 'failed' }).eq('id', row.id), 'account_deletions');
    return { status: 'blocked', reason: 'owner_transfer_required' };
  }
  unwrap(await ctx.supabase.from('account_deletions').update({ status: 'running' }).eq('id', row.id), 'account_deletions');
  try {
    unwrap(await ctx.supabase.from('ai_usage').update({ user_id: null }).eq('user_id', row.user_id), 'ai_usage');

    // Shared subjects keep working for the Turma: the creator becomes the Turma owner (creator is NOT NULL).
    const created = unwrapRows<{ id: string; owner_class_group_id: string | null }>(
      await ctx.supabase.from('subjects').select('id,owner_class_group_id').eq('created_by', row.user_id).is('deleted_at', null),
      'subjects',
    );
    for (const subject of created.filter((s) => s.owner_class_group_id)) {
      const group = unwrap(await ctx.supabase.from('class_groups').select('owner_id').eq('id', subject.owner_class_group_id ?? '').maybeSingle(), 'class_groups') as {
        owner_id: string;
      } | null;
      if (group) unwrap(await ctx.supabase.from('subjects').update({ created_by: group.owner_id }).eq('id', subject.id), 'subjects');
    }
    if (row.delete_shared_uploads) {
      const uploads = unwrapRows<{ id: string }>(
        await ctx.supabase.from('documents').select('id').eq('uploaded_by', row.user_id).is('deleted_at', null),
        'documents',
      );
      for (const part of chunk(uploads.map((u) => u.id), IN_CHUNK)) {
        unwrap(await ctx.supabase.from('documents').update({ deleted_at: ctx.now().toISOString() }).in('id', part), 'documents');
      }
    }
    unwrap(await ctx.supabase.from('invites').delete().eq('created_by', row.user_id), 'invites');

    const exportsOf = unwrapRows<{ storage_path: string | null }>(await ctx.supabase.from('data_exports').select('storage_path').eq('user_id', row.user_id), 'data_exports');
    const paths = uniq(exportsOf.map((e) => e.storage_path).filter((p): p is string => !!p));
    if (paths.length > 0) await ctx.supabase.storage.from('exports').remove(paths);

    const removed = await ctx.supabase.auth.admin.deleteUser(row.user_id);
    if (removed.error) throw new JobDataError(`auth deleteUser: ${removed.error.message}`, 'auth');
    unwrap(
      await ctx.supabase.from('account_deletions').update({ status: 'done', completed_at: ctx.now().toISOString() }).eq('id', row.id),
      'account_deletions',
    );
    return { status: 'done' };
  } catch (err) {
    unwrap(await ctx.supabase.from('account_deletions').update({ status: 'failed' }).eq('id', row.id), 'account_deletions');
    throw err;
  }
}

/**
 * account.reset_files: after account-reset (private.reset_account) removed the rows, removes their files: the
 * personal materials with their page images, page text and slices, the student's photos and the data exports.
 * Removing what is already gone is a no-op, so the job is safe to retry.
 */
export async function handleAccountResetFiles(ctx: JobContext, raw: Record<string, unknown>): Promise<{ removed: number }> {
  const payload = ResetFilesPayload.parse(raw);
  let removed = 0;
  // documents.storage_path is relative to the bucket; older rows may carry the bucket prefix.
  removed += await removeObjects(ctx, 'documents', payload.documents.map((d) => d.storage_path.replace(/^documents\//, '')));
  for (const doc of payload.documents) {
    for (const bucket of ['page-images', 'page-text', 'slices']) removed += await removeFolder(ctx, bucket, doc.id);
  }
  removed += await removeFolder(ctx, 'photos', payload.user_id);
  removed += await removeObjects(ctx, 'exports', payload.exports);
  return { removed };
}

async function removeObjects(ctx: JobContext, bucket: string, paths: string[]): Promise<number> {
  for (const part of chunk(paths, 100)) {
    const res = await ctx.supabase.storage.from(bucket).remove(part);
    if (res.error) throw new JobDataError(`storage remove ${bucket}: ${res.error.message}`, 'storage');
  }
  return paths.length;
}

/** Removes every object under `prefix/`, sub-folders included (Storage lists one level at a time). */
async function removeFolder(ctx: JobContext, bucket: string, prefix: string): Promise<number> {
  const files: string[] = [];
  const folders = [prefix];
  while (folders.length > 0) {
    const folder = folders.pop() as string;
    const res = await ctx.supabase.storage.from(bucket).list(folder, { limit: 1000 });
    if (res.error) throw new JobDataError(`storage list ${bucket}: ${res.error.message}`, 'storage');
    for (const entry of res.data ?? []) {
      if (entry.id === null) folders.push(`${folder}/${entry.name}`);
      else files.push(`${folder}/${entry.name}`);
    }
  }
  return removeObjects(ctx, bucket, files);
}

/** Tables whose tombstones (deleted_at) are hard-deleted after 30 days (data-model §1.1). */
export const PURGE_TABLES = [
  'cards', 'questions', 'subjects', 'documents', 'knowledge_nodes', 'notes', 'glossary_terms', 'goals', 'exams', 'plan_items',
  'feed_items', 'quizzes', 'mistakes', 'class_groups',
] as const;

export interface PurgeOutcome {
  purged: Record<string, number>;
  exportsExpired: number;
  errors: Record<string, string>;
}

/** storage.purge (nightly): tombstones older than 30 days, expired export archives, unsaved captures and old inbox rows. */
export async function handleStoragePurge(ctx: JobContext, raw: Record<string, unknown>): Promise<PurgeOutcome> {
  PurgePayload.parse(raw);
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - TOMBSTONE_TTL_MS).toISOString();
  const purged: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const table of PURGE_TABLES) {
    const res = await ctx.supabase.from(table).delete().lt('deleted_at', cutoff).select('id');
    if (res.error) errors[table] = res.error.message;
    else purged[table] = (res.data ?? []).length;
  }
  const expired = unwrapRows<{ id: string; storage_path: string | null }>(
    await ctx.supabase.from('data_exports').select('id,storage_path').eq('status', 'ready').lt('expires_at', now.toISOString()),
    'data_exports',
  );
  for (const e of expired) {
    if (e.storage_path) await ctx.supabase.storage.from('exports').remove([e.storage_path]);
    unwrap(await ctx.supabase.from('data_exports').update({ status: 'expired', storage_path: null }).eq('id', e.id), 'data_exports');
  }
  const idempotency = await ctx.db.query("delete from private.idempotency_keys where created_at < now() - interval '24 hours'");
  purged.idempotency_keys = idempotency.rowCount ?? 0;
  // The Central de notificações keeps 60 days (data-model R34).
  const inbox = await ctx.db.query("delete from public.notification_inbox where created_at < now() - interval '60 days'");
  purged.notification_inbox = inbox.rowCount ?? 0;
  purged.camera_captures = await purgeCaptures(ctx, now);
  return { purged, exportsExpired: expired.length, errors };
}

/**
 * Spec 11 §8.4 (D-38): photos of captures the student did not save are deleted 30 days after the capture
 * (expires_at), together with the row. Saved captures keep their photos: they back an essay, a question or a
 * document. Failed captures already lost their photos; their tombstoned rows go here too.
 */
export async function purgeCaptures(ctx: JobContext, now: Date): Promise<number> {
  const expired = unwrapRows<{ id: string; image_paths: string[] }>(
    await ctx.supabase.from('camera_captures').select('id,image_paths').eq('saved', false).lt('expires_at', now.toISOString()).limit(500),
    'camera_captures',
  );
  for (const capture of expired) {
    const objects = capture.image_paths.filter((p) => p.startsWith('photos/')).map((p) => p.slice('photos/'.length));
    if (objects.length > 0) await ctx.supabase.storage.from('photos').remove(objects);
    unwrap(await ctx.supabase.from('camera_captures').delete().eq('id', capture.id), 'camera_captures');
  }
  return expired.length;
}

export const jobs: JobDefinition[] = [
  { name: 'account.export', retryLimit: 3, handler: async (ctx, data) => void (await handleAccountExport(ctx, data)) },
  { name: 'account.delete', retryLimit: 5, handler: async (ctx, data) => void (await handleAccountDelete(ctx, data)) },
  { name: 'account.reset_files', retryLimit: 5, handler: async (ctx, data) => void (await handleAccountResetFiles(ctx, data)) },
  { name: 'storage.purge', retryLimit: 1, schedule: '15 6 * * *', handler: async (ctx, data) => void (await handleStoragePurge(ctx, data)) },
];
