// podcast-create (INT-01.2, INT-01.6; api §4.8). Resolves the scope to topics, computes the reuse cache key
// (spec 12 §8.4) and returns a cached episode at no cost when one exists: Resumão and Aprofundado of a shared
// subject are shared in the Turma; Revisão pra prova is always personal (it uses the student's mastery).
// Otherwise the episode row is created and podcast.generate (worker) writes the script and the audio.
import { ApiFailure, PodcastCreateReqSchema, allocatePodcastTopics, podcastCacheKey, type PodcastCreateReq, type PodcastCreateRes } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { activeJobCount, createAiJob } from '../shared/jobs.ts';

interface NodeRow {
  id: string;
  subject_id: string;
  parent_id: string | null;
  kind: 'unit' | 'topic' | 'concept';
  title: string;
  position: number | null;
  deleted_at: string | null;
}

export const handler = defineFunction<PodcastCreateReq>({
  name: 'podcast-create',
  mutating: true,
  aiCall: true,
  input: PodcastCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const subject = await requireSubject(db, userId, input.subject_id, 'read');

    // Scope → topics (a unit stands for its topics).
    const picked = await db.from('knowledge_nodes').select('id, subject_id, parent_id, kind, title, position, deleted_at').in('id', input.node_ids);
    if (picked.error) throw picked.error;
    const rows = (picked.data as NodeRow[]).filter((n) => n.subject_id === subject.id && !n.deleted_at);
    const unitIds = rows.filter((n) => n.kind === 'unit').map((n) => n.id);
    let topics = rows.filter((n) => n.kind === 'topic');
    if (unitIds.length > 0) {
      const children = await db.from('knowledge_nodes').select('id, subject_id, parent_id, kind, title, position, deleted_at').in('parent_id', unitIds).eq('kind', 'topic');
      if (children.error) throw children.error;
      topics = [...topics, ...(children.data as NodeRow[]).filter((n) => !n.deleted_at)];
    }
    topics = [...new Map(topics.map((t) => [t.id, t])).values()];
    if (topics.length === 0) throw new ApiFailure('invalid_request', { message: 'Escolha pelo menos um tópico com material.' });

    if (input.exam_id) {
      const exam = await db.from('exams').select('id, user_id').eq('id', input.exam_id).is('deleted_at', null).maybeSingle();
      if (exam.error) throw exam.error;
      if (!exam.data || exam.data.user_id !== userId) throw new ApiFailure('not_found');
    }

    // Weights (spec 12 §8.2): Revisão pra prova by 1 − mastery; the other styles weigh topics equally.
    const weights = new Map<string, number>(topics.map((t) => [t.id, 1]));
    if (input.style === 'exam_review') {
      const mastery = await db.from('mastery').select('node_id, mastery').eq('user_id', userId).in('node_id', topics.map((t) => t.id));
      if (mastery.error) throw mastery.error;
      for (const m of mastery.data as Array<{ node_id: string; mastery: number }>) weights.set(m.node_id, 1 - Number(m.mastery));
    }
    const allocation = allocatePodcastTopics(topics.map((t) => ({ node_id: t.id, title: t.title, weight: weights.get(t.id) ?? 1 })), input.length_minutes);

    const notes = await db.from('notes').select('version').in('node_id', topics.map((t) => t.id)).eq('depth', 'study').eq('status', 'ready');
    if (notes.error) throw notes.error;
    const notesVersion = (notes.data as Array<{ version: number }>).reduce((max, n) => Math.max(max, Number(n.version ?? 1)), 0);
    const personal = input.style === 'exam_review';
    const cacheKey = podcastCacheKey({
      subjectId: subject.id,
      nodeIds: allocation.included.map((t) => t.node_id),
      style: input.style,
      lengthMinutes: input.length_minutes,
      notesVersion,
      ownerUserId: personal ? userId : null,
    });

    const cached = await db.from('podcast_episodes').select('id, status').eq('cache_key', cacheKey).neq('status', 'failed').maybeSingle();
    if (cached.error) throw cached.error;
    if (cached.data) {
      const body: PodcastCreateRes = { episode_id: cached.data.id as string, status: cached.data.status as PodcastCreateRes['status'], cached: true, dropped_topics: allocation.dropped.map((d) => d.title) };
      return ctx.json(body);
    }

    if ((await activeJobCount(deps, userId)) >= 3) {
      throw new ApiFailure('rate_limited', { message: 'Você já tem 3 gerações em andamento. Espera uma terminar.' });
    }
    const episodeId = deps.newId();
    const title = `${subject.name}: ${allocation.included.map((t) => t.title).join(', ')}`.slice(0, 160);
    const inserted = await db.from('podcast_episodes').insert({
      id: episodeId,
      subject_id: subject.id,
      node_ids: allocation.included.map((t) => t.node_id),
      style: input.style,
      length_minutes: input.length_minutes,
      owner_user_id: personal ? userId : null,
      class_group_id: personal ? null : subject.owner_class_group_id,
      exam_id: input.exam_id ?? null,
      cache_key: cacheKey,
      title,
      script_version: 1,
      source_notes_versions: { max: notesVersion },
      status: 'queued',
      created_by: userId,
    });
    if (inserted.error) {
      // Another member asked for the same episode at the same moment: reuse it.
      if (inserted.error.code === '23505') {
        const again = await db.from('podcast_episodes').select('id, status').eq('cache_key', cacheKey).neq('status', 'failed').maybeSingle();
        if (again.data) {
          return ctx.json({ episode_id: again.data.id as string, status: again.data.status as PodcastCreateRes['status'], cached: true, dropped_topics: allocation.dropped.map((d) => d.title) } satisfies PodcastCreateRes);
        }
      }
      throw inserted.error;
    }
    const jobId = await createAiJob(deps, { type: 'podcast.generate', userId, subjectId: subject.id, stage: 'podcast' });
    await deps.execute('podcast.generate', { episode_id: episodeId, ai_job_id: jobId, user_id: userId }, { singletonKey: `podcast:${episodeId}` });
    const finished = await db.from('podcast_episodes').select('status').eq('id', episodeId).single();
    if (finished.error) throw finished.error;
    if (finished.data?.status === 'failed') throw new ApiFailure('ai_unavailable');
    const status = finished.data?.status === 'ready' ? 'ready' : 'queued';
    const body: PodcastCreateRes = { episode_id: episodeId, status, cached: false, dropped_topics: allocation.dropped.map((d) => d.title) };
    return ctx.json(body, status === 'ready' ? 200 : 202);
  },
});

export default handler;
