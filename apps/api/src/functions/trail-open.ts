// trail-open (TRL-01.1–01.3, 01.12; api §4.11). Opens the student's Trilha of a subject, creating it on first use,
// with no model call (ADR 0011): the path order is the subject's path (trail.plan, written ahead for every student)
// repaired against this student's map, or the outline order until that path exists; the steps come from the content
// written ahead. An existing trail is resumed where it stopped; when the outline changed since the plan was made, or
// the subject's path became ready for a trail that started in outline order, the chapters not started yet are
// planned again. Coming back from Ensine o Lucas closes the chapter when the lesson scored enough.
import { ApiFailure, TrailOpenReqSchema, type TrailOpenReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { inBackground } from '../shared/deps.ts';
import { advanceIfPassed, buildState, loadOutline, loadSteps, loadSubjectPlan, outlineHashOf, planFrom, prepareAhead, replan, type TrailRow } from '../shared/trail.ts';

export const handler = defineFunction<TrailOpenReq>({
  name: 'trail-open',
  mutating: true,
  input: TrailOpenReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const subject = await requireSubject(db, userId, input.subject_id, 'read');
    const [outline, subjectPlan, existing] = await Promise.all([
      loadOutline(db, userId, subject.id),
      loadSubjectPlan(db, subject.id),
      db.from('trails').select('*').eq('user_id', userId).eq('subject_id', subject.id).maybeSingle(),
    ]);
    if (outline.topics.length === 0) {
      throw new ApiFailure('not_found', { message: 'Essa matéria ainda não tem conteúdo pronto pra trilha. Envie o material e espera ele ficar pronto.' });
    }
    const hash = outlineHashOf(outline);
    if (existing.error) throw existing.error;
    let trail = existing.data as TrailRow | null;

    // No path for this map yet (an older subject, or a map that changed): plan it for the subject in the background.
    const planning = !subjectPlan || subjectPlan.outline_hash !== outline.subjectHash
      ? inBackground(deps, 'trail.plan_subject', { subject_id: subject.id, user_id: userId }, subject.id).catch((err) => {
          console.warn('[trail-open] plan in background', err instanceof Error ? err.message : err);
          return null;
        })
      : Promise.resolve(null);

    if (!trail) {
      const row: TrailRow = {
        id: deps.newId(),
        user_id: userId,
        subject_id: subject.id,
        status: 'active',
        goal: subjectPlan?.goal ?? null,
        plan: planFrom(outline, outline.topics, subjectPlan),
        outline_hash: hash,
        chapter_index: 0,
        prompt_version: subjectPlan?.prompt_version ?? null,
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
    // A trail that started in outline order takes the subject's path, once it exists, for the chapters not started.
    const adopt = trail.prompt_version === null && subjectPlan !== null;
    if (trail.outline_hash !== hash || adopt) {
      const next = replan(trail, outline, new Set(steps.map((s) => s.topic_id)), subjectPlan);
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
    const [state] = await Promise.all([buildState(deps, advanced.trail, steps, outline, { chapterDone: advanced.chapterDone }), prepareAhead(deps, advanced.trail), planning]);
    return ctx.json(state);
  },
});

export default handler;
