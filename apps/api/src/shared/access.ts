// Explicit authorization for service-role queries (security-privacy §3, §4; api §2.2 404 rule).
// Each helper mirrors a SQL helper of foundation.sql (can_read_subject, can_edit_subject,
// can_upload_to_subject, is_member, is_moderator). A subject the caller may not see is reported as
// not found, so existence is never revealed.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure } from '@studify/shared';

export interface SubjectRow {
  id: string;
  owner_profile_id: string | null;
  owner_class_group_id: string | null;
  created_by: string;
  content_language: string | null;
  is_language_subject: boolean;
  enem_area: string | null;
  name: string;
  /** Global content (ENEM bank, Atualidades): readable by every student, written only by the server. */
  system_kind?: string | null;
}

const SUBJECT_COLUMNS = 'id, owner_profile_id, owner_class_group_id, created_by, content_language, is_language_subject, enem_area, name, system_kind';

export async function activeMembership(db: SupabaseClient, userId: string, groupId: string): Promise<{ role: string } | null> {
  const { data, error } = await db
    .from('class_group_members')
    .select('role, status')
    .eq('class_group_id', groupId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data ? { role: data.role as string } : null;
}

export async function loadSubject(db: SupabaseClient, subjectId: string): Promise<SubjectRow | null> {
  const { data, error } = await db.from('subjects').select(SUBJECT_COLUMNS).eq('id', subjectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return (data as SubjectRow | null) ?? null;
}

/** can_read_subject: personal owner, an active member of the owning Turma, or a system subject (policy subjects_select_system). */
export async function canReadSubject(db: SupabaseClient, userId: string, subject: SubjectRow): Promise<boolean> {
  if (subject.system_kind) return true;
  if (subject.owner_profile_id === userId) return true;
  if (subject.owner_class_group_id) return (await activeMembership(db, userId, subject.owner_class_group_id)) !== null;
  return false;
}

/** can_edit_subject: personal owner; Turma owner/moderator; or the member who created the shared subject. */
export async function canEditSubject(db: SupabaseClient, userId: string, subject: SubjectRow): Promise<boolean> {
  if (subject.system_kind) return false;
  if (subject.owner_profile_id === userId) return true;
  if (!subject.owner_class_group_id) return false;
  const membership = await activeMembership(db, userId, subject.owner_class_group_id);
  if (!membership) return false;
  if (membership.role === 'owner' || membership.role === 'moderator') return true;
  return subject.created_by === userId;
}

/** can_upload_to_subject: edit rights, or any active member when the Turma allows member uploads. */
export async function canUploadToSubject(db: SupabaseClient, userId: string, subject: SubjectRow): Promise<boolean> {
  if (await canEditSubject(db, userId, subject)) return true;
  if (!subject.owner_class_group_id) return false;
  const { data, error } = await db.from('class_groups').select('allow_member_uploads').eq('id', subject.owner_class_group_id).maybeSingle();
  if (error) throw error;
  return data?.allow_member_uploads === true && (await activeMembership(db, userId, subject.owner_class_group_id)) !== null;
}

/**
 * Loads a subject the caller must be able to read. Invisible → 404. `need` 'edit' or 'upload' on a
 * visible subject → 403 (the subject exists and is visible, the action is not allowed).
 */
export async function requireSubject(
  db: SupabaseClient,
  userId: string,
  subjectId: string,
  need: 'read' | 'edit' | 'upload' = 'read',
): Promise<SubjectRow> {
  const subject = await loadSubject(db, subjectId);
  if (!subject || !(await canReadSubject(db, userId, subject))) throw new ApiFailure('not_found');
  if (need === 'read') return subject;
  const allowed = need === 'edit' ? await canEditSubject(db, userId, subject) : await canUploadToSubject(db, userId, subject);
  if (!allowed) throw new ApiFailure('forbidden');
  return subject;
}

/** Rows that carry a personal owner (cards, questions, explanations): another user's personal row is not found. */
export function personalRowVisible(personalForUserId: string | null | undefined, userId: string): boolean {
  return !personalForUserId || personalForUserId === userId;
}

/** Loads a node and its subject, then checks read access. Invisible → 404. */
export async function requireNode(db: SupabaseClient, userId: string, nodeId: string): Promise<{ node: Record<string, unknown>; subject: SubjectRow }> {
  const { data, error } = await db.from('knowledge_nodes').select('*').eq('id', nodeId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiFailure('not_found');
  const subject = await requireSubject(db, userId, data.subject_id as string, 'read');
  return { node: data as Record<string, unknown>, subject };
}

/**
 * private.is_public_question: a question of a system subject is visible only when it is a published ENEM item or
 * a practice question of a live Atualidades item. Questions of other subjects are not "public".
 */
export async function isPublicQuestion(db: SupabaseClient, questionId: string): Promise<boolean> {
  const item = await db.from('enem_items').select('id').eq('question_id', questionId).eq('review_status', 'ok').maybeSingle();
  if (item.error) throw item.error;
  if (item.data) return true;
  const atual = await db.from('atualidades_items').select('id, digest_id').contains('question_ids', [questionId]).eq('withdrawn', false).limit(5);
  if (atual.error) throw atual.error;
  for (const row of (atual.data as Array<{ digest_id: string }> | null) ?? []) {
    const digest = await db.from('atualidades_digests').select('status').eq('id', row.digest_id).maybeSingle();
    if (digest.error) throw digest.error;
    if (digest.data?.status === 'published') return true;
  }
  return false;
}

/** A question the student may answer: readable subject, not someone else's personal row, and public if global. */
export async function questionVisible(
  db: SupabaseClient,
  userId: string,
  question: { id: string; subject_id: string; personal_for_user_id?: string | null },
  subject: SubjectRow | null,
): Promise<boolean> {
  if (!subject || !personalRowVisible(question.personal_for_user_id, userId)) return false;
  if (subject.system_kind) return isPublicQuestion(db, question.id);
  return canReadSubject(db, userId, subject);
}

/** private.is_app_admin: the operator role (profiles.app_role = app_admin). Admin endpoints answer 403 otherwise. */
export async function requireAppAdmin(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db.from('profiles').select('app_role').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (data?.app_role !== 'app_admin') throw new ApiFailure('forbidden');
}
