// Route table: function name (the path segment after /api/) to its handler. Every handler is the same
// `(req, deps)` shape, so the server only dispatches; each function still answers its own CORS, 405, 401,
// idempotency and SSE behaviour (shared/http.ts).
import type { P2Deps } from './shared-p2/deps.ts';

import { handler as accountDelete } from './functions/account-delete.ts';
import { handler as accountExport } from './functions/account-export.ts';
import { handler as battleAnswer } from './functions/battle-answer.ts';
import { handler as battleControl } from './functions/battle-control.ts';
import { handler as battleJoin } from './functions/battle-join.ts';
import { handler as cardDraft } from './functions/card-draft.ts';
import { handler as cardsGenerateMore } from './functions/cards-generate-more.ts';
import { handler as duelAnswer } from './functions/duel-answer.ts';
import { handler as duelCreate } from './functions/duel-create.ts';
import { handler as duelNext } from './functions/duel-next.ts';
import { handler as duelRespond } from './functions/duel-respond.ts';
import { handler as explain } from './functions/explain.ts';
import { handler as flagCreate } from './functions/flag-create.ts';
import { handler as gradeAnswer } from './functions/grade-answer.ts';
import { handler as guardianLink } from './functions/guardian-link.ts';
import { handler as ingestRetry } from './functions/ingest-retry.ts';
import { handler as ingestStart } from './functions/ingest-start.ts';
import { handler as joinClass } from './functions/join-class.ts';
import { handler as noteGenerate } from './functions/note-generate.ts';
import { handler as outlineEdit } from './functions/outline-edit.ts';
import { handler as planRecompute } from './functions/plan-recompute.ts';
import { handler as provaProvavelGenerate } from './functions/prova-provavel-generate.ts';
import { handler as questionsGenerateMore } from './functions/questions-generate-more.ts';
import { handler as quizCreate } from './functions/quiz-create.ts';
import { handler as quizShare } from './functions/quiz-share.ts';
import { handler as quizSharedOpen } from './functions/quiz-shared-open.ts';
import { handler as quizSubmit } from './functions/quiz-submit.ts';
import { handler as reportCreate } from './functions/report-create.ts';
import { handler as scheduleImport } from './functions/schedule-import.ts';
import { handler as scopeResolve } from './functions/scope-resolve.ts';
import { handler as signupComplete } from './functions/signup-complete.ts';
import { handler as syncPush } from './functions/sync-push.ts';
import { handler as tutorChat } from './functions/tutor-chat.ts';
import { handler as uploadPhotos } from './functions/upload-photos.ts';
import { handler as vesperaPrepare } from './functions/vespera-prepare.ts';

export type Handler = (req: Request, deps: P2Deps) => Promise<Response>;

export const ROUTES: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ['account-delete', accountDelete],
  ['account-export', accountExport],
  ['battle-answer', battleAnswer],
  ['battle-control', battleControl],
  ['battle-join', battleJoin],
  ['card-draft', cardDraft],
  ['cards-generate-more', cardsGenerateMore],
  ['duel-answer', duelAnswer],
  ['duel-create', duelCreate],
  ['duel-next', duelNext],
  ['duel-respond', duelRespond],
  ['explain', explain],
  ['flag-create', flagCreate],
  ['grade-answer', gradeAnswer],
  ['guardian-link', guardianLink],
  ['ingest-retry', ingestRetry],
  ['ingest-start', ingestStart],
  ['join-class', joinClass],
  ['note-generate', noteGenerate],
  ['outline-edit', outlineEdit],
  ['plan-recompute', planRecompute],
  ['prova-provavel-generate', provaProvavelGenerate],
  ['questions-generate-more', questionsGenerateMore],
  ['quiz-create', quizCreate],
  ['quiz-share', quizShare],
  ['quiz-shared-open', quizSharedOpen],
  ['quiz-submit', quizSubmit],
  ['report-create', reportCreate],
  ['schedule-import', scheduleImport],
  ['scope-resolve', scopeResolve],
  ['signup-complete', signupComplete],
  ['sync-push', syncPush],
  ['tutor-chat', tutorChat],
  ['upload-photos', uploadPhotos],
  ['vespera-prepare', vesperaPrepare],
]);
