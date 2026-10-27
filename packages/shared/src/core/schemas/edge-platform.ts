// Edge Function payloads: account, ingestion and schedule import (api.md §4.1 and §4.2).
// Request bodies are validated by the function; responses are validated by the client wrapper.
// `sync-push` lives in sync.ts. Mutating calls also send an Idempotency-Key header (api §2.4).
import { z } from 'zod';
import { DOCUMENT_KIND, SCHOOL_YEAR } from '../enums.ts';
import {
  InviteCodeSchema,
  IsoInstantSchema,
  StoragePathSchema,
  UuidSchema,
} from './common.ts';

// ---------------------------------------------------------------- signup-complete (PLT-02, SP-01–03)

export const SignupCompleteReqSchema = z.object({
  invite_code: InviteCodeSchema, // pilot or Turma invite
  birth_month: z.int().min(1).max(12),
  birth_year: z.int().min(1950).max(2100),
  display_name: z.string().min(2).max(30),
  avatar_preset: z.string().min(1).optional(),
  school_year: z.enum(SCHOOL_YEAR),
  privacy_notice_version: z.string().min(1),
});
export type SignupCompleteReq = z.infer<typeof SignupCompleteReqSchema>;

export const SignupCompleteResSchema = z.object({
  profile_id: UuidSchema,
  guardian_required: z.boolean(), // under 16 with SP-03 enabled (Phase 2)
  class_group: z
    .object({ id: UuidSchema, name: z.string(), status: z.enum(['active', 'pending']) })
    .optional(), // present when a Turma code was used
});
export type SignupCompleteRes = z.infer<typeof SignupCompleteResSchema>;

// ---------------------------------------------------------------- account (SP-14, PLT-02.9)

/** `account-export` answers 202 with the export id; the file arrives later via `data_exports` and a push. */
export const AccountExportResSchema = z.object({ export_id: UuidSchema });

export const AccountDeleteReqSchema = z.object({
  otp_code: z.string().regex(/^\d{6}$/, 'six-digit email code'), // fresh re-authentication (api §4.1)
  delete_shared_uploads: z.boolean(),
});
export type AccountDeleteReq = z.infer<typeof AccountDeleteReqSchema>;

export const AccountDeleteResSchema = z.object({
  deletion_id: UuidSchema,
  completes_by: IsoInstantSchema, // at most 15 days
});

// ---------------------------------------------------------------- guardian-link (SP-03, SP-04, Phase 2)

export const GuardianLinkReqSchema = z.object({ guardian_email: z.email() });
export const GuardianLinkResSchema = z.object({
  link_id: UuidSchema,
  status: z.literal('pending'),
});

// ---------------------------------------------------------------- ingestion (ING-01…03)

export const IngestModeSchema = z.enum(['full', 'outline_only']);

export const IngestStartReqSchema = z.object({
  document_id: UuidSchema,
  mode: IngestModeSchema.optional(),
});
export type IngestStartReq = z.infer<typeof IngestStartReqSchema>;

export const IngestStartResSchema = z.object({
  job_id: UuidSchema,
  estimated_pages: z.int().min(0),
  mode: IngestModeSchema,
  budget_note: z.literal('outline_only_today').optional(),
});

/** Stages a retry can restart from (api §4.2 `ingest-retry`). */
export const IngestRetryStageSchema = z.enum(['S0', 'S1', 'S4']);

export const IngestRetryReqSchema = z.object({
  document_id: UuidSchema,
  from_stage: IngestRetryStageSchema.optional(),
});
export const IngestRetryResSchema = z.object({ job_id: UuidSchema });

/** Photos become a `documents` row of kind `photo` (ING-01, CAM-01). The server builds the PDF. */
export const UploadPhotosReqSchema = z.object({
  subject_id: UuidSchema,
  image_paths: z.array(StoragePathSchema).min(1),
});
export const UploadPhotosResSchema = z.object({
  document_id: UuidSchema,
  job_id: UuidSchema,
});

// ---------------------------------------------------------------- schedule-import (ING-07, Phase 2)

export const ScheduleImportReqSchema = z.object({ document_id: UuidSchema });
/** 202: the job fills `schedule_imports.extracted`; RPC `apply_schedule_import` creates draft exams. */
export const ScheduleImportResSchema = z.object({
  job_id: UuidSchema,
  schedule_import_id: UuidSchema,
});

/** Document kinds a client may set on upload. Re-exported so the upload form and the server agree. */
export const DocumentKindInputSchema = z.enum(DOCUMENT_KIND);
