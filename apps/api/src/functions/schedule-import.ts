// schedule-import — ING-07 (Phase 2). Queues the worker job that extracts exam dates from a schedule document.
// The student's own uploads only. The job fills schedule_imports.extracted; apply_schedule_import creates drafts.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { canReadSubject, loadSubject } from '../shared/access.ts';
import { inBackground } from '../shared/deps.ts';

export const ScheduleImportInput = z.object({ document_id: z.uuid() });
export type ScheduleImportInput = z.infer<typeof ScheduleImportInput>;

export const handler = defineP2<ScheduleImportInput>({
  name: 'schedule-import',
  mutating: true,
  input: ScheduleImportInput,
  run: async (ctx) => {
    const { p2, input: i } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;

    const doc = await db.from('documents').select('id, subject_id, uploaded_by').eq('id', i.document_id).is(
      'deleted_at',
      null,
    ).maybeSingle();
    if (doc.error) throw doc.error;
    if (!doc.data || doc.data.uploaded_by !== me) throw new ApiFailure('not_found');
    const subject = await loadSubject(db, doc.data.subject_id as string);
    if (!subject || !(await canReadSubject(db, me, subject))) throw new ApiFailure('not_found');

    const scheduleImportId = p2.newId();
    const inserted = await db.from('schedule_imports').insert({
      id: scheduleImportId,
      user_id: me,
      document_id: i.document_id,
      extracted: [],
      status: 'draft',
    });
    if (inserted.error) throw inserted.error;

    const jobId = await inBackground(p2, 'schedule.import', { schedule_import_id: scheduleImportId }, `schedule-import:${scheduleImportId}`);
    if (!jobId) throw new ApiFailure('internal_error', { message: 'Não consegui iniciar a leitura do cronograma.' });
    return ctx.json({ job_id: jobId, schedule_import_id: scheduleImportId }, 202);
  },
});
