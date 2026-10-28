// argument-start (INT-03.1–03.4; api §4.8). Opens a Treino de Argumentação: theme from the suggestions, an ENEM
// theme or a typed one (moderated, spec 12 §8.8). School sessions on a topic keep the topic slices server-side so
// the opponent can cite the material. The opening is fixed text (no AI): the student states the thesis first.
import { ApiFailure, ArgumentStartReqSchema, type ArgumentStartReq, type ArgumentStartRes } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { loadTopic, topicSlices } from '../shared/topic.ts';
import { storedSliceOf } from '../shared/retrieval.ts';
import { argumentOpening } from '../shared-p4/argument.ts';
import { requireAllowedText } from '../shared-p4/moderation.ts';

export const handler = defineFunction<ArgumentStartReq>({
  name: 'argument-start',
  mutating: true,
  aiCall: true,
  input: ArgumentStartReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;

    let theme = input.theme?.trim() ?? '';
    if (input.theme_id) {
      const res = await db.from('essay_themes').select('id, title, source, created_by, deleted_at').eq('id', input.theme_id).maybeSingle();
      if (res.error) throw res.error;
      const row = res.data as { title: string; source: string; created_by: string | null; deleted_at: string | null } | null;
      if (!row || row.deleted_at || (row.source === 'custom' && row.created_by !== userId)) throw new ApiFailure('not_found');
      theme = row.title;
    }
    if (input.theme_source === 'custom' && !input.theme_id) await requireAllowedText(deps, userId, theme, 'INT-03');

    let subjectId: string | null = input.subject_id ?? null;
    const context: Record<string, unknown> = {};
    if (subjectId) await requireSubject(db, userId, subjectId, 'read');
    if (input.goal_mode === 'exam_week' && input.node_id) {
      const bundle = await loadTopic(db, userId, input.node_id);
      subjectId = bundle.subject.id;
      try {
        const { prepared } = await topicSlices(deps, bundle);
        context.slices = prepared.map(storedSliceOf);
      } catch (err) {
        // A topic without pages still debates, just without 📄 citations.
        if (!(err instanceof ApiFailure)) throw err;
      }
      context.node_id = input.node_id;
    }

    const id = deps.newId();
    const opening = argumentOpening(theme, input.mode, input.goal_mode);
    const inserted = await db.from('argument_sessions').insert({
      id,
      user_id: userId,
      goal_mode: input.goal_mode,
      subject_id: subjectId,
      theme,
      theme_id: input.theme_id ?? null,
      theme_source: input.theme_source,
      mode: input.mode,
      round_limit: input.round_limit ?? 4,
      rounds: [],
      raw_turns: [],
      status: 'active',
      context,
    });
    if (inserted.error) throw inserted.error;
    return ctx.json({ session_id: id, theme, opening } satisfies ArgumentStartRes, 201);
  },
});

export default handler;
