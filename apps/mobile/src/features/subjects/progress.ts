// Material processing progress, as the processing screen, the subject card and the material rows show it. Built on
// the shared liveJobProgress, so the app and the live notification always name the same step and fill the bar alike.
import { liveJobProgress } from '@studify/shared';
import { t } from '../../i18n';
import type { AiJob, DocumentRow } from './api';

/** The material's own ingestion job (side jobs such as the material check never stand for its progress). */
export function ingestionJob(jobs: readonly AiJob[] | undefined, documentId?: string): AiJob | undefined {
  return jobs?.find((j) => INGESTION_TYPES.has(j.type) && (!documentId || j.document_id === documentId));
}

const INGESTION_TYPES: ReadonlySet<string> = new Set(['ingest.document', 'ingest.merge']);
/** Stages whose items are topics ("12 de 20 tópicos"). */
const TOPIC_STAGES: ReadonlySet<string> = new Set(['S2', 'S3', 'S4']);

export interface IngestionView {
  /** One line: the current step and, while topics are being worked on, how many are done. */
  label: string;
  /** Overall share of the work, 0–1; only moves forward. */
  fraction: number;
  /** The same four steps as the live notification (LIVE_JOB_STEPS). */
  steps: { label: string; state: 'done' | 'active' | 'pending' | 'failed' }[];
}

/** What the processing screen, the subject card and the material rows show for a material. */
export function ingestionView(job: AiJob | undefined, doc?: Pick<DocumentRow, 'status'>): IngestionView {
  const stageProgress = job?.items_total ? (job.items_done ?? 0) / job.items_total : (job?.progress ?? null);
  const ready = doc?.status === 'ready' || job?.status === 'succeeded';
  const status = ready ? 'succeeded' : doc?.status === 'failed' ? 'failed' : (job?.status ?? 'queued');
  const p = liveJobProgress('ingest.document', job?.stage ?? null, status, stageProgress);
  const steps = p.steps.map((s) => ({ label: s.label, state: s.state }));
  if (doc?.status === 'waiting_budget' || job?.status === 'waiting_budget') return { label: t('ingest.stages.waiting_budget'), fraction: p.fraction, steps };
  if (status === 'failed' || status === 'cancelled') return { label: t('ingest.stages.failed'), fraction: p.fraction, steps };
  if (ready) return { label: t('ingest.stages.done'), fraction: 1, steps };
  if (!job) return { label: t('ingest.stages.uploaded'), fraction: 0, steps };
  const active = p.steps.find((s) => s.state === 'active')?.label ?? p.steps[0]!.label;
  const count = job.items_total && job.stage && TOPIC_STAGES.has(job.stage) ? ` · ${t('ingest.topics_count', { done: job.items_done ?? 0, total: job.items_total })}` : '';
  return { label: `${active}…${count}`, fraction: p.fraction, steps };
}

export function stageLabel(job: AiJob | undefined, doc?: DocumentRow): string {
  return ingestionView(job, doc).label;
}
