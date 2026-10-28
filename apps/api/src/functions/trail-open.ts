// trail-open (TRL-01.1–01.3, 01.12; api §4.11). Opens the student's Trilha of a subject, creating it on first use:
// the path order comes from trail.plan (outline order when the call fails). An existing trail is resumed where it
// stopped; when the outline changed since the plan was made, the chapters not started yet are planned again. Coming
// back from Ensine o Lucas closes the chapter when the lesson scored enough.
import { ApiFailure, TrailOpenReqSchema, type TrailOpenReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { advanceIfPassed, buildState, loadOutline, loadSteps, outlineHashOf, planChapters, replan, type TrailRow } from '../shared/trail.ts';

export const handler = defineFunction<TrailOpenReq>({
  name: 'trail-open',
  mutating: true,
  aiCall: true,
  input: TrailOpenReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const subject = await requireSubject(db, userId, input.subject_id, 'read');
    const outline = await loadOutline(db, userId, subject.id);
    if (outline.topics.length === 0) {
      throw new ApiFailure('not_found', { message: 'Essa matéria ainda não tem conteúdo pronto pra trilha. Envie o material e espera ele ficar pronto.' });
    }
    const hash = outlineHashOf(outline);

    const existing = await db.from('trails').select('*').eq('user_id', userId).eq('subject_id', subject.id).maybeSingle();
    if (existing.error) throw existing.error;
    let trail = existing.data as TrailRow | null;

    if (!trail) {
      const planned = await planChapters(deps, userId, subject, outline, outline.topics, []);
      const row: TrailRow = {
        id: deps.newId(),
        user_id: userId,
        subject_id: subject.id,
        status: 'active',
        goal: planned.goal,
        plan: planned.chapters,
        outline_hash: hash,
        chapter_index: 0,
        prompt_version: planned.promptVersion,
        preparing_until: null,
        completed_at: null,
      };
      const inserted = await db.from('trails').insert(row);
      if (inserted.error?.code === '23505') {
        // Opened on two devices at once: the other request created it first.
        const again = await db.from('trails').select('*').eq('user_id', userId).eq('subject_id', subject.id).single();
        if (again.error) throw again.error;
        trail = again.data as TrailRow;
      } else if (inserted.error) {
        throw inserted.error;
      } else {
        trail = row;
      }
    }

    let steps = await loadSteps(db, trail.id);
    if (trail.outline_hash !== hash) {
      const started = new Set(steps.map((s) => s.topic_id));
      const next = await replan(deps, userId, subject, trail, outline, started);
      const completed = next.chapterIndex >= next.plan.length;
      const patch = {
        plan: next.plan,
        chapter_index: next.chapterIndex,
        goal: next.goal,
        prompt_version: next.promptVersion,
        outline_hash: hash,
        status: completed ? ('completed' as const) : ('active' as const),
        completed_at: completed ? (trail.completed_at ?? ctx.now.toISOString()) : null,
      };
      const upd = await db.from('trails').update(patch).eq('id', trail.id);
      if (upd.error) throw upd.error;
      trail = { ...trail, ...patch };
      steps = await loadSteps(db, trail.id);
    }

    const advanced = await advanceIfPassed(deps, trail, steps, outline, ctx.now);
    return ctx.json(await buildState(deps, advanced.trail, steps, outline, { chapterDone: advanced.chapterDone }));
  },
});

export default handler;
