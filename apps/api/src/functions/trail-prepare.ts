// trail-prepare (TRL-01.8; api §4.11). Generates the content the Trilha needs next — at most one generation per
// call: what blocks the next step if anything does, else one step of lookahead (the buffer). The app calls it
// when the state says `preparing` (and waits) or `prefetch` (in the background). One generation runs at a time
// per trail (lease); a concurrent call returns the current state and the app asks again.
import { TrailPrepareReqSchema, type TrailPrepareReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { buildState, loadOutline, loadSteps, loadTrail, needsOf, releaseLease, takeLease } from '../shared/trail.ts';
import { generate } from '../shared/trail-generate.ts';

export const handler = defineFunction<TrailPrepareReq>({
  name: 'trail-prepare',
  // Structured result computed directly inside SSE (ADR 0010).
  streamResult: true,
  mutating: true,
  aiCall: true,
  input: TrailPrepareReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const trail = await loadTrail(db, userId, input.trail_id);
    const subject = await requireSubject(db, userId, trail.subject_id, 'read');
    const outline = await loadOutline(db, userId, subject.id);

    if (await takeLease(db, trail.id, ctx.now)) {
      try {
        const steps = await loadSteps(db, trail.id);
        const need = needsOf(trail, steps)[0];
        if (need) {
          try {
            await generate(deps, userId, subject, trail, need.chapterIndex, need.need, steps, outline);
          } catch (err) {
            // Lookahead is best effort; only a step the student is waiting for reports the failure.
            if (need.blocking) throw err;
            console.warn('[trail-prepare] lookahead failed', err instanceof Error ? err.message : err);
          }
        }
      } finally {
        await releaseLease(db, trail.id);
      }
    }

    return ctx.json(await buildState(deps, trail, await loadSteps(db, trail.id), outline));
  },
});

export default handler;
