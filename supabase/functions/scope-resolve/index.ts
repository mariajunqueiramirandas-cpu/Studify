// scope-resolve (GOL-03). Maps the content list of a test (typed, pasted, or from a document) onto the
// subject's knowledge map. The result is a draft: the student confirms it with RPC confirm_exam_scope.
import { z } from 'zod';
import { ApiFailure, ScopeResolveReqSchema, } from '@studify/shared';
import type { ScopeResolveRes } from '../_shared/responses.ts';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../_shared/http.ts';
import { requireSubject } from '../_shared/access.ts';
import { callTask, unwrapResult } from '../_shared/ai.ts';
import { budgetCtxFor } from '../_shared/ctx.ts';
import { claudeDepsFor } from '../_shared/deps.ts';

type Req = z.infer<typeof ScopeResolveReqSchema>;
interface ScopeItemOut {
  raw_text: string;
  normalized_title: string;
  matches: Array<{ node_key: string; confidence: number }>;
  status: 'matched' | 'partial' | 'unmatched';
}

export const handler = defineFunction<Req>({
  name: 'scope-resolve',
  mutating: true,
  aiCall: true,
  input: ScopeResolveReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const exam = await deps.db.from('exams').select('id, user_id, subject_id').eq('id', input.exam_id).is('deleted_at', null).maybeSingle();
    if (exam.error) throw exam.error;
    if (!exam.data || exam.data.user_id !== userId) throw new ApiFailure('not_found');
    if (!exam.data.subject_id) {
      throw new ApiFailure('invalid_request', { message: 'Escolhe a matéria da prova antes de montar o conteúdo.' });
    }
    const subject = await requireSubject(deps.db, userId, exam.data.subject_id as string, 'read');

    let text: string;
    if (input.text !== undefined) text = input.text;
    else if (input.items !== undefined) text = input.items.join('\n');
    else {
      const pages = await deps.db
        .from('document_pages')
        .select('page_number, text')
        .eq('document_id', input.document_id as string)
        .order('page_number');
      if (pages.error) throw pages.error;
      text = (pages.data as Array<{ text: string | null }>).map((p) => p.text ?? '').join('\n').trim();
      if (text.length === 0) throw new ApiFailure('photo_unreadable');
    }

    const nodes = await deps.db.from('knowledge_nodes').select('id, kind, title, summary').eq('subject_id', subject.id).is('deleted_at', null);
    if (nodes.error) throw nodes.error;
    const excluded = await deps.db.from('node_user_settings').select('node_id, excluded').eq('user_id', userId).eq('excluded', true);
    if (excluded.error) throw excluded.error;
    const excludedIds = new Set((excluded.data as Array<{ node_id: string }>).map((r) => r.node_id));
    const outline = (nodes.data as Array<{ id: string; kind: 'unit' | 'topic' | 'concept'; title: string; summary: string | null }>).map((n) => ({
      key: n.id,
      kind: n.kind,
      title: n.title,
      summary: n.summary ?? '',
      excluded: excludedIds.has(n.id),
    }));
    const validKeys = new Set(outline.map((o) => o.key));

    const task = getTask('scope.match');
    const built = task.build({ contentList: { kind: 'text', text }, outline, contentLanguage: subject.content_language ?? 'pt-BR' });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'scope.match',
      ctx: budgetCtxFor(subject, userId, 'GOL-03', 'user'),
    });
    const data = unwrapResult(result) as { items: ScopeItemOut[] };

    await deps.db.from('exam_scope_items').delete().eq('exam_id', input.exam_id);
    await deps.db.from('exam_scope_nodes').delete().eq('exam_id', input.exam_id).eq('source', 'ai');
    const itemsOut: ScopeRes['items'] = [];
    for (const [position, item] of data.items.entries()) {
      const itemId = deps.newId();
      const inserted = await deps.db.from('exam_scope_items').insert({
        id: itemId,
        exam_id: input.exam_id,
        raw_text: item.raw_text,
        position,
        status: item.status,
        placeholder_node_id: null,
        source_document_id: input.document_id ?? null,
      });
      if (inserted.error) throw inserted.error;
      const nodesOut = item.matches.filter((m) => validKeys.has(m.node_key)).map((m) => ({ node_id: m.node_key, confidence: m.confidence }));
      if (nodesOut.length > 0) {
        const written = await deps.db.from('exam_scope_nodes').upsert(
          nodesOut.map((n) => ({ exam_id: input.exam_id, node_id: n.node_id, scope_item_id: itemId, source: 'ai', confidence: n.confidence, confirmed: false })),
          { onConflict: 'exam_id,node_id', ignoreDuplicates: true },
        );
        if (written.error) throw written.error;
      }
      itemsOut.push({ id: itemId, raw_text: item.raw_text, status: item.status, nodes: nodesOut });
    }
    const moved = await deps.db.from('exams').update({ scope_status: 'pending_review' }).eq('id', input.exam_id);
    if (moved.error) throw moved.error;

    const body: ScopeRes = { items: itemsOut, scope_status: 'pending_review' };
    return ctx.json(body);
  },
});

type ScopeRes = ScopeResolveRes;

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
