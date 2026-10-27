// admin-enem-import (ENM-02.8; api §4.10). Enqueues the bank import of one edition: the worker downloads the
// booklets, answer keys and microdata, crops and transcribes items, cross-checks keys and publishes what passes.
import { AdminEnemImportReqSchema, type AdminEnemImportReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireAppAdmin } from '../shared/access.ts';
import { createAiJob } from '../shared/jobs.ts';

export const handler = defineFunction<AdminEnemImportReq>({
  name: 'admin-enem-import',
  mutating: true,
  input: AdminEnemImportReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    await requireAppAdmin(deps.db, ctx.user.userId);
    const jobId = await createAiJob(deps, { type: 'enem.import_edition', userId: ctx.user.userId, stage: 'import' });
    await deps.enqueue(
      'enem.import_edition',
      { year: input.year, application: input.application, ai_job_id: jobId, requested_by: ctx.user.userId },
      { singletonKey: `enem.import_edition:${input.year}:${input.application}` },
    );
    return ctx.json({ job_id: jobId }, 202);
  },
});

export default handler;
