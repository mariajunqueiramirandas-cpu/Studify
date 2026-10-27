// Contract checks for every function: 401 without a JWT, 400 for an invalid body, 400 without an
// Idempotency-Key on mutating calls, 405 for GET, 426 for a schema newer than this server.
import { assertEquals } from '@std/assert';
import { makeHarness, request, json, withUsers, IDEM_KEY } from './fakes.ts';
import { handler as signupComplete } from '../signup-complete/index.ts';
import { handler as syncPush } from '../sync-push/index.ts';
import { handler as accountExport } from '../account-export/index.ts';
import { handler as accountDelete } from '../account-delete/index.ts';
import { handler as ingestStart } from '../ingest-start/index.ts';
import { handler as ingestRetry } from '../ingest-retry/index.ts';
import { handler as uploadPhotos } from '../upload-photos/index.ts';
import { handler as noteGenerate } from '../note-generate/index.ts';
import { handler as explain } from '../explain/index.ts';
import { handler as cardsGenerateMore } from '../cards-generate-more/index.ts';
import { handler as cardDraft } from '../card-draft/index.ts';
import { handler as questionsGenerateMore } from '../questions-generate-more/index.ts';
import { handler as tutorChat } from '../tutor-chat/index.ts';
import { handler as quizCreate } from '../quiz-create/index.ts';
import { handler as quizSubmit } from '../quiz-submit/index.ts';
import { handler as gradeAnswer } from '../grade-answer/index.ts';
import { handler as flagCreate } from '../flag-create/index.ts';
import { handler as reportCreate } from '../report-create/index.ts';
import { handler as scopeResolve } from '../scope-resolve/index.ts';
import { handler as planRecompute } from '../plan-recompute/index.ts';
import { handler as vesperaPrepare } from '../vespera-prepare/index.ts';

import type { Deps } from '../_shared/deps.ts';

type Handler = (req: Request, deps: Deps) => Promise<Response>;

/** name, handler, whether the call is mutating (needs Idempotency-Key), and a body that fails validation. */
const FUNCTIONS: Array<[string, Handler, boolean, unknown]> = [
  ['signup-complete', signupComplete, false, { invite_code: 'x' }],
  ['sync-push', syncPush, true, { schema_version: 1, device_id: 'd', items: [] }],
  ['account-export', accountExport, true, undefined],
  ['account-delete', accountDelete, true, {}],
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
];

for (const [name, handler, mutating, invalid] of FUNCTIONS) {
  Deno.test(`${name}: 401 without a JWT`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { token: null }), h.deps);
    assertEquals(res.status, 401);
    assertEquals((await json(res)).error.code, 'forbidden');
  });

  Deno.test(`${name}: 401 with an unknown JWT`, async () => {
    const h = makeHarness();
    const res = await handler(request(name, { token: 'nobody' }), h.deps);
    assertEquals(res.status, 401);
  });

  if (invalid !== undefined) {
    Deno.test(`${name}: 400 for an invalid body`, async () => {
      const h = makeHarness();
      withUsers(h);
      const res = await handler(request(name, { body: invalid }), h.deps);
      assertEquals(res.status, 400);
      assertEquals((await json(res)).error.code, 'invalid_request');
    });
  }

  if (mutating) {
    Deno.test(`${name}: 400 without an Idempotency-Key`, async () => {
      const h = makeHarness();
      withUsers(h);
      const res = await handler(request(name, { body: invalid ?? {}, idem: null }), h.deps);
      assertEquals(res.status, 400);
    });
  }

  Deno.test(`${name}: 405 for GET`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { method: 'GET', body: undefined }), h.deps);
    assertEquals(res.status, 405);
  });

  Deno.test(`${name}: 426 for a sync schema newer than the server`, async () => {
    const h = makeHarness();
    withUsers(h);
    const res = await handler(request(name, { headers: { 'x-studify-schema': '99' }, body: invalid ?? {} }), h.deps);
    assertEquals(res.status, 426);
    assertEquals((await json(res)).error.code, 'app_update_required');
  });
}

Deno.test('OPTIONS answers the CORS preflight without auth', async () => {
  const h = makeHarness();
  const res = await ingestStart(new Request('http://f.test/x', { method: 'OPTIONS' }), h.deps);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
});

Deno.test('the idempotency key is a UUID v7 (rejects v4)', async () => {
  const h = makeHarness();
  withUsers(h);
  const res = await ingestStart(request('ingest-start', { idem: '0190a000-0000-4000-8000-0000000000aa', body: {} }), h.deps);
  assertEquals(res.status, 400);
  assertEquals(IDEM_KEY.length, 36);
});
