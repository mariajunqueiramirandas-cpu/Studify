// mnemonic-suggest (MEM-06.3; class A). Three mnemonic options for a card, a concept or a list from a note. The
// options are checked before they reach the student: an acrostic must encode the list in order, and a palace
// option must use the student's own loci in order. Saving is a direct, owner-only insert (mnemonics, RLS).
import { getTask, type MnemonicOptionsOutput } from '@studify/prompts';
import {
  ApiFailure,
  MnemonicSuggestReqSchema,
  encodesItems,
  isMnemonicList,
  type MnemonicSuggestReq,
  type MnemonicSuggestRes,
} from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { requireNode, requireSubject } from '../shared/access.ts';

/** A card back that is a list ("Prófase, metáfase, anáfase e telófase") as its items, or [] when it is not one. */
export function listItemsOf(text: string): string[] {
  const parts = text
    .replace(/\s+e\s+/gi, ',')
    .split(/[,;\n•]+/)
    .map((p) => p.replace(/^\s*(\d+[.)]|-)\s*/, '').trim())
    .filter(Boolean);
  return isMnemonicList(parts) ? parts : [];
}

export const handler = defineFunction<MnemonicSuggestReq>({
  name: 'mnemonic-suggest',
  mutating: false,
  aiCall: true,
  input: MnemonicSuggestReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;

    let target: { kind: 'card' | 'concept'; front: string; back: string };
    let subject;
    let nodeId: string | null = null;
    if (input.card_id) {
      const card = await deps.db.from('cards').select('id, subject_id, node_id, front, back, personal_for_user_id').eq('id', input.card_id).is('deleted_at', null).maybeSingle();
      if (card.error) throw card.error;
      if (!card.data || (card.data.personal_for_user_id && card.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
      subject = await requireSubject(deps.db, userId, card.data.subject_id as string, 'read');
      target = { kind: 'card', front: card.data.front as string, back: card.data.back as string };
      nodeId = card.data.node_id as string;
    } else {
      const { node, subject: s } = await requireNode(deps.db, userId, input.node_id!);
      subject = s;
      target = { kind: 'concept', front: node.title as string, back: (node.summary as string | null) ?? '' };
      nodeId = node.id as string;
    }

    let loci: string[] = [];
    if (input.palace_id) {
      const palace = await deps.db.from('memory_palaces').select('loci, user_id').eq('id', input.palace_id).is('deleted_at', null).maybeSingle();
      if (palace.error) throw palace.error;
      if (!palace.data || palace.data.user_id !== userId) throw new ApiFailure('not_found');
      loci = palace.data.loci as string[];
    }
    const items = input.items ?? listItemsOf(target.back);
    if (input.type === 'palace' && items.length > loci.length) {
      throw new ApiFailure('invalid_request', { message: `Seu palácio tem ${loci.length} lugares e a lista tem ${items.length} itens. Escolha um palácio maior.` });
    }

    const built = getTask('mnemonics.suggest').build({
      target,
      items,
      type: input.type,
      loci,
      excludeTitles: input.exclude_titles ?? [],
      contentLanguage: subject.content_language ?? 'pt-BR',
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'mnemonics.suggest', ctx: budgetCtxFor(subject, userId, 'MEM-06', 'user', { nodeId }) })) as MnemonicOptionsOutput;

    const options = out.options
      .filter((o) => input.type === 'any' || o.type === input.type)
      .filter((o) => (items.length && (o.type === 'acronym' || o.type === 'phrase') ? encodesItems(o.type, o.text, items) : true))
      .filter((o) => (o.type === 'palace' ? !!o.loci && o.loci.length === items.length && o.loci.every((l, i) => l.locus === loci[i] && l.item === items[i]) : true))
      .map((o) => ({
        type: o.type,
        title: o.title,
        content: {
          text: o.text,
          how_to_use: o.how_to_use,
          ...(items.length ? { items } : {}),
          ...(o.type === 'palace' && o.loci ? { loci: o.loci } : {}),
        },
      }));
    if (options.length === 0) throw new ApiFailure('ai_unavailable', { message: 'Não saiu nenhuma ideia boa dessa vez. Toca em "Outras ideias".' });
    return ctx.json({ options } satisfies MnemonicSuggestRes);
  },
});

export default handler;
