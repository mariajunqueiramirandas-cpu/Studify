import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { ApiError, callFunction } from '../../api/functions';
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
  /** Set when the work began; progress cards count elapsed time and time left from it. */
  started_at?: string | null;
  created_at: string;
  updated_at: string;
}

const FINISHED_JOB = new Set(['done', 'succeeded', 'failed', 'cancelled']);

/**
 * A job row as Realtime delivers it, written straight into the caches the screens read (the subject's jobs, the job
 * itself), so progress moves the moment the server writes it instead of at the next poll. When a job finishes, or a
 * material's map is written, what it produced is read again.
 */
export function mergeJobRow(qc: QueryClient, row: Partial<AiJob> & { id: string }): void {
  qc.setQueryData(['job', row.id], (prev: object | undefined) => (prev ? { ...prev, ...row } : prev));
  const subjectId = row.subject_id;
  if (!subjectId) return;
  let previous: AiJob | undefined;
  qc.setQueryData<AiJob[]>(['subject', subjectId, 'jobs'], (list) => {
    if (!list) return list;
    previous = list.find((j) => j.id === row.id);
    return previous ? list.map((j) => (j.id === row.id ? { ...j, ...row } : j)) : [row as AiJob, ...list].slice(0, 5);
  });
  if (row.status && FINISHED_JOB.has(row.status) && !FINISHED_JOB.has(previous?.status ?? '')) {
    void qc.invalidateQueries({ queryKey: ['subject', subjectId] });
  } else if (row.stage && row.stage !== previous?.stage) {
    void qc.invalidateQueries({ queryKey: ['subject', subjectId, 'outline'] });
    void qc.invalidateQueries({ queryKey: ['subject', subjectId, 'documents'] });
  }
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
        rows<Subject>(supabase.from('subjects').select('*').is('deleted_at', null).is('system_kind', null).order('created_at')),
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
    // Realtime keeps the rows current (mergeJobRow); the poll is the fallback for a dropped connection.
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => !FINISHED_JOB.has(j.status)) ? 8000 : false),
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
  onProcessing?: (stage: string, progress?: number) => void;
}

export type UploadOutcome =
  | { ok: true; documentId: string; jobId: string; mode: 'full' | 'outline_only' }
  | { ok: false; code: string; existingDocumentId?: string };

const MAX_BYTES = 100 * 1024 * 1024;

/**
 * ING-01 upload flow (api.md §6): the PDF goes to Storage, then ingest-start. The server creates the documents
 * row (checksum, size, duplicate check) — the app never writes it.
 */
export async function uploadMaterial(input: UploadInput): Promise<UploadOutcome> {
  if (input.size > MAX_BYTES) return { ok: false, code: 'too_large' };
  const documentId = uuidv7();
  const storagePath = `${input.subjectId}/${documentId}.pdf`;
  await uploadFile({ bucket: 'documents', path: storagePath, uri: input.uri, contentType: 'application/pdf', onProgress: input.onProgress });
  let processingStage = 'S0';
  try {
    const res = await callFunction<IngestStartBody, { job_id: string; mode: 'full' | 'outline_only' }>(
      'ingest-start',
      {
        document_id: documentId,
        subject_id: input.subjectId,
        title: input.name.replace(/\.pdf$/i, '').trim().slice(0, 200) || 'Material',
        kind: input.kind,
        teacher_name: input.teacherName ?? null,
      },
      { idempotencyKey: documentId, onProgress: (event) => {
        if (event.key !== 'operation.progress') return;
        const progress = event.params as { stage?: string; progress?: number } | undefined;
        if (progress?.stage) processingStage = progress.stage;
        input.onProcessing?.(processingStage, progress?.progress);
      } },
    );
    return { ok: true, documentId, jobId: res.job_id, mode: res.mode };
  } catch (e) {
    if (e instanceof ApiError && e.status > 0 && e.status < 500 && e.code !== 'unauthorized') {
      const existing = e.details?.existing_document_id;
      return { ok: false, code: e.code, existingDocumentId: typeof existing === 'string' ? existing : undefined };
    }
    throw e;
  }
}

interface IngestStartBody {
  document_id: string;
  subject_id: string;
  title: string;
  kind: DocumentKind;
  teacher_name: string | null;
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

/** Signed URL of a stored `bucket/path` (refreshed before the 1 h TTL ends); null path → null. */
export function useStorageUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['signedUrl', path],
    enabled: !!path,
    staleTime: 50 * 60 * 1000,
    queryFn: () => {
      const slash = path!.indexOf('/');
      return signedUrl(path!.slice(0, slash), path!.slice(slash + 1));
    },
  });
}
