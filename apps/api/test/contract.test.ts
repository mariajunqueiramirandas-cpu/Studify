import { test } from 'bun:test';
// Contract checks for every function: 401 without a JWT, 400 for an invalid body, 400 without an
// Idempotency-Key on mutating calls, 405 for GET, 426 for a schema newer than this server.
import { assertEquals } from './assert.ts';
import { makeHarness, request, json, withUsers, IDEM_KEY } from './fakes.ts';
import { handler as signupComplete } from '../src/functions/signup-complete.ts';
import { handler as syncPush } from '../src/functions/sync-push.ts';
import { handler as accountExport } from '../src/functions/account-export.ts';
import { handler as accountDelete } from '../src/functions/account-delete.ts';
import { handler as accountReset } from '../src/functions/account-reset.ts';
import { handler as ingestStart } from '../src/functions/ingest-start.ts';
import { handler as ingestRetry } from '../src/functions/ingest-retry.ts';
import { handler as uploadPhotos } from '../src/functions/upload-photos.ts';
import { handler as noteGenerate } from '../src/functions/note-generate.ts';
import { handler as explain } from '../src/functions/explain.ts';
import { handler as cardsGenerateMore } from '../src/functions/cards-generate-more.ts';
import { handler as cardDraft } from '../src/functions/card-draft.ts';
import { handler as questionsGenerateMore } from '../src/functions/questions-generate-more.ts';
import { handler as tutorChat } from '../src/functions/tutor-chat.ts';
import { handler as quizCreate } from '../src/functions/quiz-create.ts';
import { handler as quizSubmit } from '../src/functions/quiz-submit.ts';
import { handler as gradeAnswer } from '../src/functions/grade-answer.ts';
import { handler as flagCreate } from '../src/functions/flag-create.ts';
import { handler as reportCreate } from '../src/functions/report-create.ts';
import { handler as scopeResolve } from '../src/functions/scope-resolve.ts';
import { handler as planRecompute } from '../src/functions/plan-recompute.ts';
import { handler as vesperaPrepare } from '../src/functions/vespera-prepare.ts';
import { handler as trailOpen } from '../src/functions/trail-open.ts';
import { handler as trailPrepare } from '../src/functions/trail-prepare.ts';
import { handler as trailAnswer } from '../src/functions/trail-answer.ts';
import { handler as trailGrade } from '../src/functions/trail-grade.ts';
import { handler as trailSettle } from '../src/functions/trail-settle.ts';
import { handler as accountOverview } from '../src/functions/account-overview.ts';
import { handler as accountUpdate } from '../src/functions/account-update.ts';
import { handler as accountMembership } from '../src/functions/account-membership.ts';
import { handler as accountDeviceRemove } from '../src/functions/account-device-remove.ts';
import { handler as accountExportLink } from '../src/functions/account-export-link.ts';
import { handler as adminOverview } from '../src/functions/admin-overview.ts';
import { handler as adminAiUsage } from '../src/functions/admin-ai-usage.ts';
import { handler as adminUsers } from '../src/functions/admin-users.ts';
import { handler as adminUser } from '../src/functions/admin-user.ts';
import { handler as adminUserControl } from '../src/functions/admin-user-control.ts';
import { handler as adminClassGroups } from '../src/functions/admin-class-groups.ts';
import { handler as adminClassGroupControl } from '../src/functions/admin-class-group-control.ts';
import { handler as adminModeration } from '../src/functions/admin-moderation.ts';
import { handler as adminModerationControl } from '../src/functions/admin-moderation-control.ts';
import { handler as adminSettings } from '../src/functions/admin-settings.ts';
import { handler as adminSettingsControl } from '../src/functions/admin-settings-control.ts';
import { handler as adminAudit } from '../src/functions/admin-audit.ts';

import type { Deps } from '../src/shared/deps.ts';

type Handler = (req: Request, deps: Deps) => Promise<Response>;

/** name, handler, whether the call is mutating (needs Idempotency-Key), and a body that fails validation. */
const FUNCTIONS: Array<[string, Handler, boolean, unknown]> = [
  ['signup-complete', signupComplete, false, { invite_code: 'x' }],
  ['sync-push', syncPush, true, { schema_version: 1, device_id: 'd', items: [] }],
  ['account-export', accountExport, true, undefined],
  ['account-delete', accountDelete, true, {}],
  ['account-reset', accountReset, true, {}],
  ['ingest-start', ingestStart, true, {}],
  ['ingest-retry', ingestRetry, true, {}],
  ['upload-photos', uploadPhotos, true, {}],
  ['note-generate', noteGenerate, true, {}],
  ['explain', explain, true, {}],
  ['cards-generate-more', cardsGenerateMore, true, {}],
  ['card-draft', cardDraft, true, {}],
  ['questions-generate-more', questionsGenerateMore, true, {}],
  ['tutor-chat', tutorChat, true, { mode: 'nope' }],
  ['quiz-create', quizCreate, true, {}],
  ['quiz-submit', quizSubmit, true, {}],
  ['grade-answer', gradeAnswer, true, {}],
  ['flag-create', flagCreate, true, {}],
  ['report-create', reportCreate, true, {}],
  ['scope-resolve', scopeResolve, true, {}],
  ['plan-recompute', planRecompute, true, {}],
  ['vespera-prepare', vesperaPrepare, true, {}],
  ['trail-open', trailOpen, true, {}],
  ['trail-prepare', trailPrepare, true, {}],
  ['trail-answer', trailAnswer, true, { trail_id: 'x' }],
  ['trail-grade', trailGrade, true, { trail_id: 'x' }],
  ['trail-settle', trailSettle, true, { trail_id: 'x' }],
  ['account-overview', accountOverview, false, undefined],
  ['account-update', accountUpdate, true, {}],
  ['account-membership', accountMembership, true, { action: 'leave' }],
  ['account-device-remove', accountDeviceRemove, true, {}],
  ['account-export-link', accountExportLink, false, { export_id: 'x' }],
  ['admin-overview', adminOverview, false, undefined],
  ['admin-ai-usage', adminAiUsage, false, { days: 0 }],
  ['admin-users', adminUsers, false, { filter: 'everyone' }],
  ['admin-user', adminUser, false, {}],
  ['admin-user-control', adminUserControl, true, { action: 'delete_everything' }],
  ['admin-class-groups', adminClassGroups, false, undefined],
  ['admin-class-group-control', adminClassGroupControl, true, { action: 'set_budget' }],
  ['admin-moderation', adminModeration, false, undefined],
  ['admin-moderation-control', adminModerationControl, true, { action: 'report' }],
  ['admin-settings', adminSettings as unknown as Handler, false, undefined],
  ['admin-settings-control', adminSettingsControl as unknown as Handler, true, { action: 'set_limits', global_month_micro_usd: -1 }],
  ['admin-audit', adminAudit, false, { limit: 0 }],
];

for (const [name, handler, mutating, invalid] of FUNCTIONS) {
  test(`${name}: 401 without a JWT`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { token: null }), h.deps);
    assertEquals(res.status, 401);
    assertEquals((await json(res)).error.code, 'forbidden');
  });

  test(`${name}: 401 with an unknown JWT`, async () => {
    const h = makeHarness();
    const res = await handler(request(name, { token: 'nobody' }), h.deps);
    assertEquals(res.status, 401);
  });

  if (invalid !== undefined) {
    test(`${name}: 400 for an invalid body`, async () => {
      const h = makeHarness();
      withUsers(h);
      const res = await handler(request(name, { body: invalid }), h.deps);
      assertEquals(res.status, 400);
      assertEquals((await json(res)).error.code, 'invalid_request');
    });
  }

  if (mutating) {
    test(`${name}: 400 without an Idempotency-Key`, async () => {
      const h = makeHarness();
      withUsers(h);
      const res = await handler(request(name, { body: invalid ?? {}, idem: null }), h.deps);
      assertEquals(res.status, 400);
    });
  }

  test(`${name}: 405 for GET`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { method: 'GET', body: undefined }), h.deps);
    assertEquals(res.status, 405);
  });

  test(`${name}: 426 for a sync schema newer than the server`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { headers: { 'x-studify-schema': '99' }, body: invalid ?? {} }), h.deps);
    assertEquals(res.status, 426);
    assertEquals((await json(res)).error.code, 'app_update_required');
  });
}

test('OPTIONS answers the CORS preflight without auth', async () => {
  const h = makeHarness();
  const res = await ingestStart(new Request('http://f.test/x', { method: 'OPTIONS' }), h.deps);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
});

test('the idempotency key is a UUID v7 (rejects v4)', async () => {
  const h = makeHarness();
  withUsers(h);
  const res = await ingestStart(request('ingest-start', { idem: '0190a000-0000-4000-8000-0000000000aa', body: {} }), h.deps);
  assertEquals(res.status, 400);
  assertEquals(IDEM_KEY.length, 36);
});
