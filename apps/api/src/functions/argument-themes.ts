// argument-themes (INT-03.2 "Sugerir temas"; class A). Five debatable questions grounded in the subject's
// knowledge map; each points at the topics it draws on (the first one gives the opponent its material).
import { getTask } from '@studify/prompts';
import { ArgumentThemesReqSchema, type ArgumentThemesRes } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { requireSubject } from '../shared/access.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';

export const handler = defineFunction<z.infer<typeof ArgumentThemesReqSchema>>({
  name: 'argument-themes',
  // Structured result computed directly inside SSE (ADR 0010).
  streamResult: true,
  mutating: false,
  aiCall: true,
  input: ArgumentThemesReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const subject = await requireSubject(deps.db, userId, input.subject_id, 'read');
    const nodes = await deps.db.from('knowledge_nodes').select('id, title').eq('subject_id', subject.id).eq('kind', 'topic').is('deleted_at', null).order('position').limit(60);
    if (nodes.error) throw nodes.error;
    const rows = nodes.data as Array<{ id: string; title: string }>;
    const keyed = rows.map((n, i) => ({ key: `n${i + 1}`, title: n.title }));
    const idByKey = new Map<string, string>(rows.map((n, i) => [`n${i + 1}`, n.id]));
    const built = getTask('argument.themes').build({ subjectName: subject.name, nodes: keyed });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'argument.themes', ctx: budgetCtxFor(subject, userId, 'INT-03', 'user') })) as {
      themes: Array<{ question: string; node_keys: string[]; why: string }>;
    };
    const body: ArgumentThemesRes = {
      themes: out.themes.map((t) => ({ question: t.question, node_ids: t.node_keys.map((k) => idByKey.get(k)).filter((id): id is string => !!id).slice(0, 3), why: t.why })),
    };
    return ctx.json(body);
  },
});

export default handler;
