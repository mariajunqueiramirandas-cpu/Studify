// visual-generate (LRN-05, "Ver em diagrama"; class A). One cached visual per topic and type (LRN-05.5), shared
// in Turma subjects. Without a type the model picks one or answers that none fits, and that answer is cached as
// type 'none' so the topic is not sent again. The spec is data, rendered natively by the app (LRN-05.3).
import { decodeVisual, getTask, type VisualDraftOutput } from '@studify/prompts';
import { ApiFailure, VisualGenerateReqSchema, type VisualGenerateReq, type VisualGenerateRes, type VisualRow } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicSlices } from '../shared/topic.ts';
import { toStoredSpec } from '../shared-p5/visuals.ts';

const NO_FIT = 'Esse tópico não fica bom em diagrama.';

interface StoredVisual {
  id: string;
  node_id: string;
  type: string;
  title: string | null;
  spec: unknown;
  alt_text: string | null;
  source_pages: unknown;
}

function asRow(v: StoredVisual): VisualRow {
  return { id: v.id, node_id: v.node_id, type: v.type as VisualRow['type'], title: v.title ?? '', spec: v.spec as VisualRow['spec'], alt_text: v.alt_text ?? '', source_pages: (v.source_pages ?? []) as VisualRow['source_pages'] };
}

export const handler = defineFunction<VisualGenerateReq>({
  name: 'visual-generate',
  // Calls Claude outside a stream: runs as a job, the request answers 202 running (ADR 0009).
  deferred: true,
  mutating: true,
  aiCall: true,
  input: VisualGenerateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const bundle = await loadTopic(deps.db, userId, input.node_id);

    const cached = await deps.db
      .from('visuals')
      .select('id, node_id, type, title, spec, alt_text, source_pages')
      .eq('node_id', input.node_id)
      .eq('status', 'ready')
      .order('created_at', { ascending: false });
    if (cached.error) throw cached.error;
    const rows = (cached.data ?? []) as StoredVisual[];
    const hit = input.type ? rows.find((r) => r.type === input.type) : (rows.find((r) => r.type !== 'none') ?? rows.find((r) => r.type === 'none'));
    if (hit) {
      const body: VisualGenerateRes = hit.type === 'none' ? { fits: false, reason: hit.alt_text ?? NO_FIT } : { fits: true, visual: asRow(hit), cached: true };
      return ctx.json(body);
    }

    const { slices } = await topicSlices(deps, bundle);
    const study = await deps.db.from('notes').select('body').eq('node_id', input.node_id).eq('depth', 'study').eq('status', 'ready').is('deleted_at', null).maybeSingle();
    if (study.error) throw study.error;
    const built = getTask('visual.generate').build({
      topic: { title: bundle.title, summary: bundle.summary ?? '' },
      resumo: ((study.data?.body as string | undefined) ?? '').slice(0, 6000),
      requestedType: input.type ?? null,
      slices,
      contentLanguage: bundle.contentLanguage,
    });
    const draft = unwrapResult(
      await callTask(claudeDepsFor(deps), { built, taskId: 'visual.generate', ctx: budgetCtxFor(bundle.subject, userId, 'LRN-05', 'user', { nodeId: input.node_id }) }),
    ) as VisualDraftOutput;
    const out = decodeVisual(draft);
    if (!out) throw new ApiFailure('ai_unavailable', { message: 'Não consegui montar esse diagrama agora. Tenta de novo.' });

    if (!out.fits || !out.visual || (input.type && out.visual.type !== input.type)) {
      const reason = out.reason ?? NO_FIT;
      if (!input.type) {
        const none = await deps.db
          .from('visuals')
          .upsert({ id: deps.newId(), subject_id: bundle.subject.id, node_id: input.node_id, type: 'none', status: 'ready', alt_text: reason, spec: {}, source_pages: [], prompt_version: built.promptVersion, created_by: userId }, { onConflict: 'node_id,type', ignoreDuplicates: true });
        if (none.error) throw none.error;
      }
      return ctx.json({ fits: false, reason } satisfies VisualGenerateRes);
    }

    const stored = toStoredSpec(out.visual, built.documents?.labels ?? {});
    if ('errors' in stored) throw new ApiFailure('ai_unavailable', { message: 'Não consegui montar esse diagrama agora. Tenta de novo.' });
    const id = deps.newId();
    const row = {
      id,
      subject_id: bundle.subject.id,
      node_id: input.node_id,
      type: stored.spec.type,
      title: out.visual.title,
      spec: stored.spec,
      alt_text: out.visual.alt_text,
      source_pages: stored.sourcePages,
      status: 'ready',
      prompt_version: built.promptVersion,
      created_by: userId,
    };
    const saved = await deps.db.from('visuals').upsert(row, { onConflict: 'node_id,type' }).select('id').maybeSingle();
    if (saved.error) throw saved.error;
    const visualId = (saved.data?.id as string | undefined) ?? id;

    // LRN-05.5: the Feed de Estudos reuses the visual as a diagram card of the topic.
    const feed = await deps.db.from('feed_items').insert({
      id: deps.newId(),
      subject_id: bundle.subject.id,
      node_id: input.node_id,
      type: 'diagram',
      content: { title: out.visual.title.slice(0, 80), body: out.visual.alt_text.slice(0, 280), caption: null, question: null, visual_id: visualId },
      source_pages: stored.sourcePages,
      external_knowledge: false,
      prompt_version: built.promptVersion,
    });
    // Best effort: a failed feed card never fails the visual the student asked for.
    void feed.error;

    return ctx.json({ fits: true, visual: asRow({ ...row, id: visualId }), cached: false } satisfies VisualGenerateRes, 201);
  },
});

export default handler;
