// Moderation of user-typed text that other features reuse (spec 12 §8.8 custom debate themes, ENM-05.8 typed
// redação themes): moderation.classify on the system budget, before any generation that uses the text.
import { getTask } from '@studify/prompts';
import { ApiFailure } from '@studify/shared';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';

/** Throws invalid_request when the text is not allowed (offensive, personal data, hate…). */
export async function requireAllowedText(deps: Deps, userId: string, text: string, feature: string): Promise<void> {
  const built = getTask('moderation.classify').build({ subject: 'shared_text', text });
  const verdict = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'moderation.classify', ctx: budgetCtxFor(null, userId, feature, 'system') })) as { allowed: boolean; category: string };
  if (!verdict.allowed) {
    throw new ApiFailure('invalid_request', { message: 'Esse tema não dá pra usar aqui. Tenta outro tema, sem ofensas nem dados pessoais.' });
  }
}
