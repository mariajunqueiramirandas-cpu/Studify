// note-generate (LRN-01.4, LRN-01.12). Notes at depth tldr and study are written by the worker's Batch
// lane (content.regenerate_topic): this call returns the current note or queues one. The deep note streams
// here (notes.deep, SSE). A ready note is returned at no AI cost. Regeneration is limited per student per day
// (personal subjects) or to organizers (shared subjects).
import { z } from 'zod';
import { ApiFailure, NoteGenerateReqSchema, } from '@studify/shared';
import type { NoteGenerateRes } from '../shared/responses.ts';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { canEditSubject } from '../shared/access.ts';
import { citationsForStorage, openStream, toTaskCall } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicInput, topicSlices } from '../shared/topic.ts';
import { REGENERATE_LIMIT_PER_DAY, currentNote, supersedeCurrent, wordCount } from '../shared/notes.ts';
import { pumpStream, stopReasonOf } from '../shared/stream.ts';
import { DEFAULT_TIME_ZONE, localDateOf } from '@studify/shared';

export const handler = defineFunction<z.infer<typeof NoteGenerateReqSchema>>({
  name: 'note-generate',
  mutating: true,
  aiCall: true,
  input: NoteGenerateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const bundle = await loadTopic(db, userId, input.node_id);
    const subject = bundle.subject;

    if (input.regenerate) {
      if (subject.owner_class_group_id && !(await canEditSubject(db, userId, subject))) throw new ApiFailure('forbidden');
      if (!subject.owner_class_group_id) {
        const day = localDateOf(ctx.now, DEFAULT_TIME_ZONE);
        const start = new Date(`${day}T00:00:00-03:00`).toISOString();
        const today = await db
          .from('notes')
          .select('id', { count: 'exact', head: true })
          .eq('node_id', input.node_id)
          .eq('depth', input.depth)
          .eq('created_by', userId)
          .gte('created_at', start);
        if (today.error) throw today.error;
        if ((today.count ?? 0) >= REGENERATE_LIMIT_PER_DAY) throw new ApiFailure('regenerate_limit');
      }
    }

    const existing = await currentNote(db, input.node_id, input.depth);
    if (existing && existing.status === 'ready' && !input.regenerate) {
      const body: NoteGenerateRes = { note_id: existing.id, status: 'ready' };
      return ctx.json(body);
    }
    if (existing && !input.regenerate && existing.status !== 'ready') {
      const body: NoteGenerateRes = { note_id: existing.id, status: existing.status };
      return ctx.json(body);
    }

    if (input.depth !== 'deep') {
      if (input.regenerate) await supersedeCurrent(db, input.node_id, input.depth);
      const noteId = deps.newId();
      const inserted = await db.from('notes').insert({
        id: noteId,
        subject_id: subject.id,
        node_id: input.node_id,
        scope_kind: 'topic',
        depth: input.depth,
        body: '',
        language: subject.content_language ?? 'pt-BR',
        status: 'pending',
        created_by: userId,
      });
      if (inserted.error) throw inserted.error;
      await deps.enqueue(
        'content.regenerate_topic',
        { node_id: input.node_id, kinds: ['notes'], depth: input.depth, note_id: noteId, user_id: userId },
        { singletonKey: `${input.node_id}:notes:${input.depth}`, retryLimit: 2 },
      );
      const body: NoteGenerateRes = { note_id: noteId, status: 'pending' };
      return ctx.json(body, 202);
    }

    // depth = deep: streamed here (notes.deep, effort high, budget user).
    const { slices } = await topicSlices(deps, bundle);
    if (input.regenerate) await supersedeCurrent(db, input.node_id, 'deep');
    const noteId = deps.newId();
    const inserted = await db.from('notes').insert({
      id: noteId,
      subject_id: subject.id,
      node_id: input.node_id,
      scope_kind: 'topic',
      depth: 'deep',
      body: '',
      language: subject.content_language ?? 'pt-BR',
      status: 'generating',
      created_by: userId,
    });
    if (inserted.error) throw inserted.error;

    const task = getTask('notes.deep');
    const built = task.build({
      topic: topicInput(bundle),
      slices,
      contentLanguage: bundle.contentLanguage,
      languageSubject: bundle.languageSubject,
    });
    const session = await openStream(
      claudeDepsFor(deps),
      toTaskCall({ built, taskId: 'notes.deep', ctx: budgetCtxFor(subject, userId, 'LRN-01.4', 'user', { nodeId: input.node_id }) }),
    );

    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId });
      const { result } = await pumpStream(writer, session);
      const usage = await ctx.usagePct();
      if (result.status !== 'ok') {
        await db.from('notes').update({ status: 'failed' }).eq('id', noteId);
        writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: usage });
        return;
      }
      const citations = citationsForStorage(result.citations);
      const updated = await db
        .from('notes')
        .update({
          body: result.text,
          citations,
          word_count: wordCount(result.text),
          has_math: /\$/.test(result.text),
          status: 'ready',
          prompt_version: task.promptVersion,
          low_citation_coverage: citations.length === 0,
        })
        .eq('id', noteId);
      if (updated.error) throw updated.error;
      writer.send('done', {
        stop_reason: stopReasonOf(result.status),
        usage_pct_today: usage,
        result: { note_id: noteId },
      });
    });
  },
});

export default handler;
