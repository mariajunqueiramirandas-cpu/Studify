// explain (LRN-03). Explains a note paragraph, concept, glossary term, question explanation, card back or Trilha step in
// another style. A shared cache hit (explanations, same target, style and prompt version) streams the stored
// body at no cost. "Tentar de novo" (force_new) writes a personal explanation.
import { ApiFailure, ExplainReqSchema, type ExplainReq } from '@studify/shared';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { requireSubject, type SubjectRow } from '../shared/access.ts';
import { citationsForStorage, openStream, toTaskCall } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { prepareSlices, toPdfSlice, type PreparedSlice } from '../shared/slices.ts';
import { pumpStream, stopReasonOf } from '../shared/stream.ts';

type Req = ExplainReq;
const STYLE: Record<Req['style'], 'mais_simples' | 'analogia' | 'exemplo' | 'passo_a_passo'> = {
  simpler: 'mais_simples',
  analogy: 'analogia',
  example: 'exemplo',
  step_by_step: 'passo_a_passo',
};

interface Target {
  subject: SubjectRow;
  text: string;
  /** Cited pages of the target (document → original pages). */
  pages: Map<string, { title: string; storagePath: string; pages: Set<number> }>;
}

/** Resolves the explained text and its pages. Every target is checked against the caller's subject access. */
async function resolveTarget(deps: Deps, userId: string, req: Req): Promise<Target> {
  const { db } = deps;
  const pagesOf = new Map<string, { title: string; storagePath: string; pages: Set<number> }>();
  const addPages = async (refs: unknown) => {
    for (const ref of (Array.isArray(refs) ? refs : []) as Array<{ document_id: string; page_start: number; page_end: number }>) {
      const doc = await db.from('documents').select('title, storage_path').eq('id', ref.document_id).maybeSingle();
      if (doc.error) throw doc.error;
      if (!doc.data) continue;
      const entry = pagesOf.get(ref.document_id) ?? { title: doc.data.title as string, storagePath: doc.data.storage_path as string, pages: new Set<number>() };
      for (let p = ref.page_start; p <= ref.page_end; p += 1) entry.pages.add(p);
      pagesOf.set(ref.document_id, entry);
    }
  };

  switch (req.target_type) {
    case 'note_paragraph': {
      const note = await db.from('notes').select('id, subject_id, body, citations').eq('id', req.target_id).is('deleted_at', null).maybeSingle();
      if (note.error) throw note.error;
      if (!note.data) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, note.data.subject_id as string, 'read');
      const paragraphs = (note.data.body as string).split(/\n\s*\n/);
      const text = paragraphs[req.paragraph_index ?? 0];
      if (text === undefined) throw new ApiFailure('not_found');
      const cites = (note.data.citations as Array<{ start: number; end: number; document_id: string; page_start: number; page_end: number }>) ?? [];
      const offset = (note.data.body as string).indexOf(text);
      await addPages(cites.filter((c) => c.end >= offset && c.start <= offset + text.length));
      return { subject, text, pages: pagesOf };
    }
    case 'concept': {
      const node = await db.from('knowledge_nodes').select('id, subject_id, title, summary, parent_id').eq('id', req.target_id).is('deleted_at', null).maybeSingle();
      if (node.error) throw node.error;
      if (!node.data) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, node.data.subject_id as string, 'read');
      const sources = await db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', (node.data.parent_id as string) ?? req.target_id);
      if (sources.error) throw sources.error;
      await addPages(sources.data);
      return { subject, text: `${node.data.title}\n${node.data.summary ?? ''}`, pages: pagesOf };
    }
    case 'glossary_term': {
      const term = await db.from('glossary_terms').select('id, subject_id, term, definition, source_pages').eq('id', req.target_id).is('deleted_at', null).maybeSingle();
      if (term.error) throw term.error;
      if (!term.data) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, term.data.subject_id as string, 'read');
      await addPages(term.data.source_pages);
      return { subject, text: `${term.data.term}: ${term.data.definition}`, pages: pagesOf };
    }
    case 'question_explanation': {
      const q = await db.from('questions').select('id, subject_id, stem, explanation, source_pages, personal_for_user_id').eq('id', req.target_id).is('deleted_at', null).maybeSingle();
      if (q.error) throw q.error;
      if (!q.data || (q.data.personal_for_user_id && q.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, q.data.subject_id as string, 'read');
      await addPages(q.data.source_pages);
      return { subject, text: `${q.data.stem}\n${q.data.explanation ?? ''}`, pages: pagesOf };
    }
    case 'trail_step': {
      // TRL-01.9: a Trilha lesson, or a question once answered (explaining it before would give the answer away).
      const step = await db.from('trail_steps').select('id, user_id, trail_id, status, content, source_pages').eq('id', req.target_id).maybeSingle();
      if (step.error) throw step.error;
      if (!step.data || step.data.user_id !== userId) throw new ApiFailure('not_found');
      const content = step.data.content as { title?: string; body?: string; stem?: string; explanation?: string };
      if (content.stem && step.data.status !== 'done') throw new ApiFailure('invalid_request', { message: 'Responda a pergunta antes.' });
      const trail = await db.from('trails').select('subject_id').eq('id', step.data.trail_id).maybeSingle();
      if (trail.error) throw trail.error;
      if (!trail.data) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, trail.data.subject_id as string, 'read');
      await addPages(step.data.source_pages);
      const text = content.stem ? `${content.stem}\n${content.explanation ?? ''}` : `${content.title ?? ''}\n${content.body ?? ''}`;
      return { subject, text, pages: pagesOf };
    }
    case 'card_back': {
      const card = await db.from('cards').select('id, subject_id, front, back, source_pages, personal_for_user_id').eq('id', req.target_id).is('deleted_at', null).maybeSingle();
      if (card.error) throw card.error;
      if (!card.data || (card.data.personal_for_user_id && card.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
      const subject = await requireSubject(db, userId, card.data.subject_id as string, 'read');
      await addPages(card.data.source_pages);
      return { subject, text: `${card.data.front}\n${card.data.back}`, pages: pagesOf };
    }
  }
}

export const handler = defineFunction<Req>({
  name: 'explain',
  mutating: true,
  aiCall: true,
  input: ExplainReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const target = await resolveTarget(deps, userId, input);
    const task = getTask('explain.restyle');
    const paragraphIndex = input.paragraph_index ?? null;

    // Shared cache (data-model §5.3): same target, style, language and prompt version.
    if (!input.force_new) {
      let cached = db
        .from('explanations')
        .select('id, body, citations')
        .eq('target_type', input.target_type)
        .eq('target_id', input.target_id)
        .eq('style', input.style)
        .eq('prompt_version', task.promptVersion)
        .is('personal_for_user_id', null);
      cached = paragraphIndex === null ? cached.is('paragraph_index', null) : cached.eq('paragraph_index', paragraphIndex);
      const hit = await cached.maybeSingle();
      if (hit.error) throw hit.error;
      if (hit.data) {
        const explanationId = hit.data.id as string;
        return ctx.sse(async (writer) => {
          writer.send('meta', { request_id: ctx.requestId, explanation_id: explanationId });
          writer.send('delta', { text: hit.data?.body as string });
          writer.send('done', { stop_reason: 'end_turn', usage_pct_today: await ctx.usagePct(), result: { explanation_id: explanationId } });
        });
      }
    }

    const slices: PreparedSlice[] = [];
    for (const [documentId, entry] of target.pages) {
      slices.push(
        ...(await prepareSlices(db, {
          documentId,
          title: entry.title,
          storagePath: entry.storagePath,
          pages: [...entry.pages],
          purpose: 'topic',
          newId: deps.newId,
        })),
      );
    }
    const built = task.build({
      targetText: target.text,
      style: STYLE[input.style],
      slices: slices.map(toPdfSlice),
      contentLanguage: target.subject.content_language ?? 'pt-BR',
      languageSubject: target.subject.is_language_subject,
    });
    const session = await openStream(
      claudeDepsFor(deps),
      toTaskCall({ built, taskId: 'explain.restyle', ctx: budgetCtxFor(target.subject, userId, 'LRN-03', 'user') }),
    );

    const explanationId = deps.newId();
    const created = await db.from('explanations').insert({
      id: explanationId,
      subject_id: target.subject.id,
      target_type: input.target_type,
      target_id: input.target_id,
      paragraph_index: paragraphIndex,
      style: input.style,
      language: target.subject.content_language ?? 'pt-BR',
      body: '',
      citations: [],
      personal_for_user_id: input.force_new ? userId : null,
      prompt_version: task.promptVersion,
    });
    if (created.error && created.error.code !== '23505') throw created.error;

    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, explanation_id: explanationId });
      const { result } = await pumpStream(writer, session);
      const usage = await ctx.usagePct();
      if (result.status === 'ok') {
        const citations = citationsForStorage(result.citations);
        await db.from('explanations').update({ body: result.text, citations }).eq('id', explanationId);
      }
      writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: usage, result: { explanation_id: explanationId } });
    });
  },
});

export default handler;
