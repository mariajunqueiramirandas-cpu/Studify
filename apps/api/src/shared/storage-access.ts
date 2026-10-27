// Who may read or write a stored object: the storage policies of migration 20260101000200_storage.sql
// (data-model §7) in TypeScript. R2 has no row-level security, so the API checks these before it signs a
// URL for the app; on Supabase Storage the policies stay as a second line. The first folder of a key is
// the authorization key, as in the policies (storage.foldername(name)[1]).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BucketName, ObjectPath } from '@studify/storage';
import { activeMembership, canReadSubject, canUploadToSubject, loadSubject } from './access.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Buckets with an insert policy but no update policy: the app may add an object, never replace one. With
 * signed URLs that means refusing to sign when the object is already there.
 */
export const WRITE_ONCE: ReadonlySet<BucketName> = new Set(['documents', 'media']);

/** Memoizes the database checks of one request (a page of ENEM crops or page images repeats the same key). */
export type AccessMemo = Map<string, Promise<boolean>>;

function memo(cache: AccessMemo, key: string, check: () => Promise<boolean>): Promise<boolean> {
  let hit = cache.get(key);
  if (!hit) {
    hit = check();
    cache.set(key, hit);
  }
  return hit;
}

/**
 * private.can_read_subject. A system subject (ENEM bank, Atualidades) is readable by every student, as its
 * rows are (policy subjects_select_system); `allowSystem: false` keeps the SQL helper's answer for writes.
 */
async function subjectReadable(db: SupabaseClient, userId: string, id: string | undefined, allowSystem: boolean): Promise<boolean> {
  if (!id || !UUID.test(id)) return false;
  const subject = await loadSubject(db, id);
  if (!subject || (subject.system_kind && !allowSystem)) return false;
  return canReadSubject(db, userId, subject);
}

/** private.can_read_document: the document's subject is readable (the row may be tombstoned, as in SQL). */
async function documentReadable(db: SupabaseClient, userId: string, id: string | undefined): Promise<boolean> {
  if (!id || !UUID.test(id)) return false;
  const { data, error } = await db.from('documents').select('subject_id').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? subjectReadable(db, userId, data.subject_id as string, true) : false;
}

/** private.shares_class_with: both are active members of one Turma. */
async function sharesClassWith(db: SupabaseClient, userId: string, other: string): Promise<boolean> {
  if (!UUID.test(other)) return false;
  const { data, error } = await db.from('class_group_members').select('class_group_id').eq('user_id', userId).eq('status', 'active');
  if (error) throw error;
  for (const row of (data as Array<{ class_group_id: string }> | null) ?? []) {
    if (await activeMembership(db, other, row.class_group_id)) return true;
  }
  return false;
}

/** The select policies. */
export function canReadObject(db: SupabaseClient, userId: string, path: ObjectPath, cache: AccessMemo = new Map()): Promise<boolean> {
  const folders = path.segments.slice(0, -1);
  const first = folders[0];
  switch (path.bucket) {
    case 'documents':
    case 'media':
      return memo(cache, `subject:${first}`, () => subjectReadable(db, userId, first, true));
    case 'page-images':
    case 'page-text':
      return memo(cache, `document:${first}`, () => documentReadable(db, userId, first));
    case 'audio':
      if (first === 'answers') return Promise.resolve(folders[1] === userId);
      return memo(cache, `subject:${first}`, () => subjectReadable(db, userId, first, true));
    case 'photos':
    case 'exports':
      return Promise.resolve(first === userId);
    case 'enem':
      return Promise.resolve(true);
    case 'avatars': {
      if (path.key === `${userId}.webp`) return Promise.resolve(true);
      if (path.segments.length !== 1) return Promise.resolve(false);
      const owner = path.key.split('.')[0] ?? '';
      return memo(cache, `peer:${owner}`, () => sharesClassWith(db, userId, owner));
    }
    case 'slices':
      return Promise.resolve(false);
  }
}

/** The insert / all policies. Buckets without one are written by the API and the worker only. */
export async function canWriteObject(db: SupabaseClient, userId: string, path: ObjectPath): Promise<boolean> {
  const first = path.segments.length > 1 ? path.segments[0] : undefined;
  switch (path.bucket) {
    case 'documents': {
      if (!first || !UUID.test(first)) return false;
      const subject = await loadSubject(db, first);
      return !!subject && !subject.system_kind && (await canUploadToSubject(db, userId, subject));
    }
    case 'media':
      return subjectReadable(db, userId, first, false);
    case 'photos':
      return first === userId;
    case 'avatars':
      return path.key === `${userId}.webp`;
    default:
      return false;
  }
}
