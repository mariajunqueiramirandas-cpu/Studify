// cards-generate-more (MEM-01.6). Up to 10 new cards for one topic, deduplicated against the existing
// fronts. Structured output; every source page is checked against the pages that were sent.
import { z } from 'zod';
import { CardsGenerateMoreReqSchema, } from '@studify/shared';
import type { CardsGenerateMoreRes } from '../shared/responses.ts';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicInput, topicSlices } from '../shared/topic.ts';
import { sourceRefsToRows, normalizeFront, type ModelCard } from '../shared/cards.ts';

export const handler = defineFunction<z.infer<typeof CardsGenerateMoreReqSchema>>({
  name: 'cards-generate-more',
  // Structured result computed directly inside SSE (ADR 0010).
  streamResult: true,
  mutating: true,
  aiCall: true,
  input: CardsGenerateMoreReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const bundle = await loadTopic(deps.db, userId, input.node_id);
    const { slices } = await topicSlices(deps, bundle);

    const existing = await deps.db
      .from('cards')
      .select('front, personal_for_user_id')
      .eq('node_id', input.node_id)
      .is('deleted_at', null);
    if (existing.error) throw existing.error;
    const visible = (existing.data as Array<{ front: string; personal_for_user_id: string | null }>).filter(
      (c) => !c.personal_for_user_id || c.personal_for_user_id === userId,
    );
    const existingFronts = visible.map((c) => c.front);

    const task = getTask('cards.more');
    const built = task.build({
      topic: topicInput(bundle),
      slices,
      existingFronts,
      targetCount: 10,
      contentLanguage: bundle.contentLanguage,
      languageSubject: bundle.languageSubject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'cards.more',
      ctx: budgetCtxFor(bundle.subject, userId, 'MEM-01.6', 'user', { nodeId: input.node_id }),
    });
    const data = unwrapResult(result) as { cards: ModelCard[] };

    const seen = new Set(existingFronts.map(normalizeFront));
    const fresh: ModelCard[] = [];
    for (const card of data.cards) {
      const key = normalizeFront(card.front);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(card);
      if (fresh.length === 10) break;
    }
    const rows = sourceRefsToRows(fresh, {
      deps,
      userId,
      subjectId: bundle.subject.id,
      nodeId: input.node_id,
      conceptIds: new Set(bundle.concepts.map((c) => c.id)),
      labels: built.documents?.labels ?? {},
      promptVersion: task.promptVersion,
    });
    if (rows.length > 0) {
      const inserted = await deps.db.from('cards').insert(rows);
      if (inserted.error) throw inserted.error;
    }
    const body: CardsGenerateMoreRes = { card_ids: rows.map((r) => r.id as string) };
    return ctx.json(body);
  },
});

export default handler;
