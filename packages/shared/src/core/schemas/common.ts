// Primitive schemas shared by every payload (api.md §2). Kept free of domain logic.
import { z } from 'zod';
import { isLocalDate } from '../time.ts';

/** Any canonical UUID (users, rows created by the server). Accepts v4 and v7. */
export const UuidSchema = z.uuid();

/** Client-generated row ids must be UUID v7 (data-model §1.1, ADR 0007). */
export const Uuid7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'expected a UUID v7');

/** ISO 8601 UTC instant, e.g. 2026-11-09T13:30:00Z (api §2.7). */
export const IsoInstantSchema = z.iso.datetime();

/** Student calendar day, YYYY-MM-DD (api §2.7). */
export const LocalDateSchema = z.string().refine(isLocalDate, { message: 'expected a real YYYY-MM-DD date' });

/** Wall-clock time of day, HH:mm (study_preferences window and quiet hours). */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

/** Invite codes: 8 characters, no 0/O/1/I (security §9, data-model invites). */
export const InviteCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, 'expected an 8-character invite code');

/** Idempotency-Key header value: UUID v7 (api §2.4). */
export const IdempotencyKeySchema = Uuid7Schema;

/** Headers every client sends on Edge calls (api §2.1). */
export const ClientHeadersSchema = z.object({
  'x-studify-version': z.string().regex(/^\d+$/, 'android versionCode'),
  'x-studify-schema': z.string().regex(/^\d+$/, 'sync schema version'),
  'x-device-id': z.string().min(1).max(128),
});

/** Keyset pagination envelope (api §2.3). */
export function PageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}

/** Opaque cursor query parameter with a max page size of 200 (api §2.3). */
export const PageQuerySchema = z.object({
  limit: z.int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

/** Long free text (notes, comments, user input). Limits are the caller's concern. */
export const NonEmptyText = z.string().min(1);

/** Key of a `file_path`-style storage path, relative and without a leading slash. */
export const StoragePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('..'), { message: 'relative storage path expected' });
