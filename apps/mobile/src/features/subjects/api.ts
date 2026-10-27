import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { uploadFile } from '../../api/storage';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows, rpc } from '../common/query';
import { SUBJECT_COLORS, type SubjectColor } from '../../theme';

export interface Subject {
  id: string;
  name: string;
  color: string;
  icon: string;
  owner_profile_id: string | null;
  owner_class_group_id: string | null;
  created_by: string;
  content_language: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SubjectUserSettings {
  subject_id: string;
  user_id: string;
  pinned: boolean;
  sort_order: number;
  archived_at: string | null;
}

export interface DocumentRow {
  id: string;
  subject_id: string;
  title: string;
  kind: DocumentKind;
  detected_kind: DocumentKind | null;
  status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'waiting_budget';
  error_code: string | null;
  page_count: number | null;
  size_bytes: number;
  storage_path: string;
  teacher_name: string | null;
  created_at: string;
}

export type DocumentKind = 'slides' | 'notes' | 'textbook' | 'past_test' | 'content_list' | 'photo' | 'other';
export const UPLOAD_KINDS: DocumentKind[] = ['slides', 'notes', 'textbook', 'past_test', 'content_list'];

export interface AiJob {
  id: string;
  type: string;
  stage: string | null;
  status: string;
  items_total: number | null;
  items_done: number | null;
  progress: number | null;
  error_code: string | null;
  subject_id?: string | null;
  document_id?: string | null;
  created_at: string;
  updated_at: string;
}

// Subject colors are stored as hex (data-model CHECK); the palette key is recovered for theming.
export function colorKeyFromHex(hex: string): SubjectColor {
  const found = (Object.keys(SUBJECT_COLORS) as SubjectColor[]).find((k) => SUBJECT_COLORS[k].light.toLowerCase() === hex.toLowerCase());
  return found ?? 'indigo';
}

export function useSubjects() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['subjects', userId],
    enabled: !!userId,
    queryFn: async () => {
      const [subjects, settings] = await Promise.all([
        rows<Subject>(supabase.from('subjects').select('*').is('deleted_at', null).order('created_at')),
        rows<SubjectUserSettings>(supabase.from('subject_user_settings').select('*').eq('user_id', userId!)),
      ]);
      const byId = new Map(settings.map((s) => [s.subject_id, s]));
      return subjects.map((s) => ({ ...s, settings: byId.get(s.id) ?? null }));
    },
  });
}

export function useSubject(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject', subjectId],
    enabled: !!subjectId,
    queryFn: () => row<Subject>(supabase.from('subjects').select('*').eq('id', subjectId!).maybeSingle()),
  });
}

export function useCreateSubject() {
  const qc = useQueryClient();
  const { userId } = useSession();
  return useMutation({
    mutationFn: async (input: { name: string; color: SubjectColor; icon: string }) => {
      const id = uuidv7();
      const { error } = await supabase.from('subjects').insert({
        id,
        name: input.name.trim(),
        color: SUBJECT_COLORS[input.color].light,
        icon: input.icon,
        owner_profile_id: userId,
        created_by: userId,
      });
      if (error) throw error;
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subjects'] }),
  });
}

export function useUpdateSubject(subjectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<{ name: string; color: SubjectColor; icon: string }>) => {
      const update: Record<string, unknown> = {};
      if (patch.name) update.name = patch.name.trim();
      if (patch.color) update.color = SUBJECT_COLORS[patch.color].light;
      if (patch.icon) update.icon = patch.icon;
      const { error } = await supabase.from('subjects').update(update).eq('id', subjectId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['subjects'] });
      void qc.invalidateQueries({ queryKey: ['subject', subjectId] });
    },
  });
}

/** PLT-03.4 archive is per user (subject_user_settings), so Turma subjects can be archived too. */
export async function setSubjectArchived(userId: string, subjectId: string, archived: boolean) {
  const { error } = await supabase
    .from('subject_user_settings')
    .upsert({ user_id: userId, subject_id: subjectId, archived_at: archived ? new Date().toISOString() : null }, { onConflict: 'user_id,subject_id' });
  if (error) throw error;
}

export function useDocuments(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject', subjectId, 'documents'],
    enabled: !!subjectId,
    queryFn: () => rows<DocumentRow>(supabase.from('documents').select('*').eq('subject_id', subjectId!).is('deleted_at', null).order('created_at')),
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => d.status === 'uploaded' || d.status === 'processing') ? 5000 : false),
  });
}

/** Latest ingestion/generation job for a subject — drives the processing card (ING-03.8). */
export function useSubjectJobs(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject', subjectId, 'jobs'],
    enabled: !!subjectId,
    queryFn: () =>
      rows<AiJob>(
        supabase
          .from('ai_jobs')
          .select('*')
          .eq('subject_id', subjectId!)
          .is('parent_job_id', null)
          .order('created_at', { ascending: false })
          .limit(5),
      ),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => !['done', 'succeeded', 'failed', 'cancelled'].includes(j.status)) ? 4000 : false),
  });
}

export interface UploadInput {
  subjectId: string;
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  kind: DocumentKind;
  teacherName?: string | null;
  onProgress?: (pct: number) => void;
}

export type UploadOutcome =
  | { ok: true; documentId: string; jobId: string; mode: 'full' | 'outline_only' }
  | { ok: false; code: string; existingDocumentId?: string };

const MAX_BYTES = 100 * 1024 * 1024;

/** ING-01 upload flow (api.md §6): checksum → documents row → Storage → ingest-start. */
export async function uploadMaterial(userId: string, input: UploadInput): Promise<UploadOutcome> {
  if (input.size > MAX_BYTES) return { ok: false, code: 'too_large' };
  const file = new File(input.uri);
  const bytes = await file.bytes();
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head !== '%PDF-') return { ok: false, code: 'unsupported_type' };
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  const checksum = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');

  const existing = await row<{ id: string }>(
    supabase.from('documents').select('id').eq('subject_id', input.subjectId).eq('checksum_sha256', checksum).is('deleted_at', null).maybeSingle(),
  );
  if (existing) return { ok: false, code: 'duplicate_document', existingDocumentId: existing.id };

  const documentId = uuidv7();
  const storagePath = `${input.subjectId}/${documentId}.pdf`;
  const title = input.name.replace(/\.pdf$/i, '').slice(0, 200) || 'Material';
  const { error } = await supabase.from('documents').insert({
    id: documentId,
    subject_id: input.subjectId,
    uploaded_by: userId,
    title,
    kind: input.kind,
    storage_path: storagePath,
    mime_type: 'application/pdf',
    size_bytes: input.size,
    checksum_sha256: checksum,
    teacher_name: input.teacherName ?? null,
    status: 'uploaded',
  });
  if (error) return { ok: false, code: error.code === '23505' ? 'duplicate_document' : 'internal_error' };

  await uploadFile({ bucket: 'documents', path: storagePath, uri: input.uri, contentType: 'application/pdf', onProgress: input.onProgress });
  const res = await callFunction<{ document_id: string }, { job_id: string; mode: 'full' | 'outline_only' }>(
    'ingest-start',
    { document_id: documentId },
    { idempotencyKey: documentId },
  );
  return { ok: true, documentId, jobId: res.job_id, mode: res.mode };
}

export async function retryIngestion(documentId: string) {
  return callFunction<{ document_id: string }, { job_id: string }>('ingest-retry', { document_id: documentId });
}

export async function renameDocument(documentId: string, title: string) {
  const { error } = await supabase.from('documents').update({ title: title.trim() }).eq('id', documentId);
  if (error) throw error;
}

export async function deleteDocument(documentId: string) {
  const { error } = await supabase.from('documents').update({ deleted_at: new Date().toISOString() }).eq('id', documentId);
  if (error) throw error;
}

export async function shareSubject(subjectId: string, classGroupId: string) {
  return rpc<void>('share_subject', { subject_id: subjectId, class_group_id: classGroupId, copyright_ack: true });
}

/** Signed URL for a stored object (1 h TTL, data-model §7). */
export async function signedUrl(bucket: string, path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}
