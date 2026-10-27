// teaching-start (INT-02.2–02.4, INT-02.9; api §4.8). Builds the hidden lesson plan with lucas.plan (concepts,
// 3–5 misconceptions from the material, fix criteria, naive questions) and opens the lesson with Lucas's
// fixed opener. The plan never leaves the server (INT-02.3): the client cannot even select the column.
// An open lesson on the same topic is resumed instead of paying for a new plan.
import { LUCAS_TURNS, TeachingStartReqSchema, lucasOpener, type TeachingStartRes } from '@studify/shared';
import { getTask } from '@studify/prompts';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicInput, topicSlices } from '../shared/topic.ts';
import { scoringPlan, startState, type ModelPlan, type StoredPlan } from '../shared-p3/teaching.ts';

export const handler = defineFunction<z.infer<typeof TeachingStartReqSchema>>({
  name: 'teaching-start',
  mutating: true,
  aiCall: true,
  input: TeachingStartReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const bundle = await loadTopic(db, userId, input.node_id);

    const open = await db.from('teaching_sessions').select('id, length, messages').eq('user_id', userId).eq('node_id', input.node_id).eq('status', 'active').is('deleted_at', null).maybeSingle();
    if (open.error) throw open.error;
    if (open.data) {
      const messages = (open.data.messages as TeachingStartRes['messages']) ?? [];
      const body: TeachingStartRes = {
        session_id: open.data.id as string,
        opening: messages[0]?.text ?? lucasOpener(bundle.title),
        turn_limit: LUCAS_TURNS[open.data.length as 'short' | 'full'],
        resumed: true,
        messages: messages.map((m) => ({ role: m.role, text: m.text })),
      };
      return ctx.json(body);
    }

    // Inputs of the plan: notes, glossary, the student's own open mistakes on the topic, and the misconceptions
    // of earlier lessons (INT-02.9, so a retry meets a different Lucas).
    const note = await db.from('notes').select('body').eq('node_id', input.node_id).eq('depth', 'study').eq('status', 'ready').is('deleted_at', null).maybeSingle();
    const glossary = await db.from('glossary_terms').select('term, definition').eq('node_id', input.node_id).is('deleted_at', null).limit(12);
    const mistakes = await db.from('mistakes').select('question_id').eq('user_id', userId).eq('node_id', input.node_id).is('resolved_at', null).limit(5);
    const stems: string[] = [];
    for (const m of (mistakes.data as Array<{ question_id: string }> | null) ?? []) {
      const q = await db.from('questions').select('stem').eq('id', m.question_id).maybeSingle();
      if (q.data?.stem) stems.push((q.data.stem as string).slice(0, 160));
    }
    const previous = await db.from('teaching_sessions').select('id').eq('user_id', userId).eq('node_id', input.node_id).neq('status', 'active');
    const previousBeliefs: string[] = [];
    for (const p of (previous.data as Array<{ id: string }> | null) ?? []) {
      const full = await db.from('teaching_sessions').select('plan').eq('id', p.id).maybeSingle();
      for (const m of ((full.data?.plan as StoredPlan | undefined)?.model.misconceptions ?? [])) previousBeliefs.push(m.lucas_belief);
    }

    const { slices, prepared } = await topicSlices(deps, bundle);
    const built = getTask('lucas.plan').build({
      topic: topicInput(bundle),
      notes: ((note.data?.body as string | undefined) ?? '').slice(0, 6000),
      glossary: ((glossary.data as Array<{ term: string; definition: string }> | null) ?? []).map((g) => ({ term: g.term, definition: g.definition })),
      slices,
      commonMistakes: stems,
      previousMisconceptions: previousBeliefs.slice(-10),
      contentLanguage: bundle.contentLanguage,
      languageSubject: bundle.languageSubject,
    });
    const result = await callTask(claudeDepsFor(deps), { built, taskId: 'lucas.plan', ctx: budgetCtxFor(bundle.subject, userId, 'INT-02', 'user', { nodeId: input.node_id }) });
    const model = unwrapResult(result) as ModelPlan;
    const documents = built.documents ?? { labels: {}, allowedPages: {} };
    const opener = lucasOpener(bundle.title);
    const plan: StoredPlan = {
      model,
      scoring: scoringPlan(model, documents, opener, new Set(bundle.concepts.map((c) => c.id))),
      documents,
      slices: prepared.map((p) => ({ row_id: p.rowId, document_id: p.documentId, title: p.title, pages: p.pages, storage_path: p.storagePath })),
    };
    const sessionId = deps.newId();
    const messages = [{ role: 'lucas' as const, text: opener, at: ctx.now.toISOString() }];
    const inserted = await db.from('teaching_sessions').insert({
      id: sessionId,
      user_id: userId,
      subject_id: bundle.subject.id,
      node_id: input.node_id,
      length: input.length,
      plan,
      messages,
      raw_turns: [],
      evaluation_state: startState(plan.scoring),
      turn_count: 0,
      status: 'active',
    });
    if (inserted.error) throw inserted.error;
    const body: TeachingStartRes = { session_id: sessionId, opening: opener, turn_limit: LUCAS_TURNS[input.length], resumed: false, messages: messages.map((m) => ({ role: m.role, text: m.text })) };
    return ctx.json(body);
  },
});

export default handler;
