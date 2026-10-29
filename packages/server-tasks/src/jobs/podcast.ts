// podcast.generate (INT-01.2–01.5, spec 12 §7.1, §8.2): writes the episode script with podcast.script (topic
// notes, glossary and the topic slices; Revisão pra prova adds the student's weak concepts), validates it (word
// budget, line limits, every topic segment cites a page that was sent) with one retry, then synthesizes the
// lines with the cloud voices, concatenates the MP3 and stores the measured timeline. Without a TTS provider,
// or when the TTS budget is refused, the episode is ready with audio_path null and the app reads the script with
// on-device TTS (INT-01.11). Shared episodes go to audio/{subject}/…; personal ones to audio/answers/{owner}/….
import { z } from 'zod';
import {
  allocatePodcastTopics,
  buildPodcastTimeline,
  podcastTargetWords,
  speakableText,
  validatePodcastScript,
  type PodcastScriptDoc,
  type PodcastSegment,
} from '@studify/shared';
import { getTask, PodcastScriptSchema, type DocumentMap, type PdfSlice } from '@studify/prompts';
import { BudgetExceededError } from '@studify/ai';
import { concatMp3, ttsCostMicroUsd, type SynthesisResult, type TtsProvider } from '@studify/speech';
import type { OperationContext, OperationDefinition } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { runPrompt } from '../lib/ai-adapter.ts';
import { JobDataError, unwrap, unwrapRows } from '../lib/db.ts';
import { loadDocument, slicesFor } from '../lib/documents.ts';

const Payload = z.object({ episode_id: z.uuid(), user_id: z.uuid().nullable().optional(), ai_job_id: z.uuid().nullable().optional() });

/** Topic slices sent with the script prompt (cost cap; spec 12 §8.2 keeps episodes to the selected topics). */
export const PODCAST_MAX_SLICES = 6;
/** Lines synthesized at once. */
const TTS_CONCURRENCY = 4;

interface EpisodeRow {
  id: string;
  subject_id: string;
  node_ids: string[];
  style: 'overview' | 'deep' | 'exam_review';
  length_minutes: 5 | 10 | 15;
  owner_user_id: string | null;
  class_group_id: string | null;
  status: string;
  created_by: string;
}

interface TopicRow {
  id: string;
  title: string;
  summary: string | null;
  learning_objectives: string[] | null;
}

type ModelScript = z.infer<typeof PodcastScriptSchema>;

export interface PodcastOutcome {
  status: 'ready' | 'failed' | 'skipped';
  audio: boolean;
  reason?: string;
}

/** Model output → stored script: topic keys to node ids, document labels to ids, pages outside the slices dropped. */
export function mapScript(model: ModelScript, keyToNode: ReadonlyMap<string, string>, documents: DocumentMap | null): PodcastScriptDoc {
  const segments: PodcastSegment[] = model.segments.map((s) => ({
    id: s.id,
    kind: s.kind,
    node_ids: s.node_keys.map((k) => keyToNode.get(k)).filter((v): v is string => !!v),
    title: s.title,
    lines: s.lines.map((l) => ({ speaker: l.speaker, text: l.text, pause_after_ms: l.pause_after_ms })),
    source_pages: s.source_pages
      .filter((r) => documents?.labels[r.doc] && (documents.allowedPages[r.doc] ?? []).includes(r.page_start) && (documents.allowedPages[r.doc] ?? []).includes(r.page_end))
      .map((r) => ({ document_id: documents!.labels[r.doc]!, page_start: r.page_start, page_end: r.page_end })),
    recall_question: s.recall_question,
  }));
  return { title: model.title, segments };
}

function pageAllowedIn(documents: DocumentMap | null) {
  const byId = new Map<string, Set<number>>();
  for (const [label, id] of Object.entries(documents?.labels ?? {})) {
    const set = byId.get(id) ?? new Set<number>();
    for (const p of documents?.allowedPages[label] ?? []) set.add(p);
    byId.set(id, set);
  }
  return (documentId: string, page: number) => byId.get(documentId)?.has(page) ?? false;
}

async function topicSlices(ctx: OperationContext, nodeIds: readonly string[]): Promise<PdfSlice[]> {
  const sources = unwrapRows<{ node_id: string; document_id: string; page_start: number; page_end: number }>(
    await ctx.supabase.from('node_sources').select('node_id,document_id,page_start,page_end').in('node_id', [...nodeIds]).is('deleted_at', null),
    'node_sources',
  );
  const out: PdfSlice[] = [];
  const seen = new Set<string>();
  // Round-robin over topics so every topic gets pages before any topic gets a second slice.
  for (const nodeId of nodeIds) {
    for (const s of sources.filter((x) => x.node_id === nodeId)) {
      if (out.length >= PODCAST_MAX_SLICES) return out;
      const pages: number[] = [];
      for (let p = s.page_start; p <= s.page_end; p++) pages.push(p);
      const doc = await loadDocument(ctx, s.document_id).catch(() => null);
      if (!doc) continue;
      for (const slice of await slicesFor(ctx, doc, pages)) {
        const key = `${slice.documentId}:${slice.pages[0]}`;
        if (seen.has(key) || out.length >= PODCAST_MAX_SLICES) continue;
        seen.add(key);
        out.push(slice);
      }
    }
  }
  return out;
}

async function fail(ctx: OperationContext, episodeId: string, code: string): Promise<PodcastOutcome> {
  unwrap(await ctx.supabase.from('podcast_episodes').update({ status: 'failed', error_code: code }).eq('id', episodeId), 'podcast_episodes');
  await ctx.progress({ status: 'failed', error_code: code });
  return { status: 'failed', audio: false, reason: code };
}

/** Synthesizes every line (bounded concurrency) or returns null when one line fails; `onLine` counts the lines done. */
async function synthesizeLines(tts: TtsProvider, script: PodcastScriptDoc, onLine?: (done: number, total: number) => void): Promise<SynthesisResult[] | null> {
  const lines = script.segments.flatMap((s) => s.lines);
  const out: SynthesisResult[] = new Array(lines.length);
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < lines.length) {
      const index = next++;
      const line = lines[index]!;
      try {
        out[index] = await tts.synthesize({ text: speakableText(line.text), voice: line.speaker, pauseAfterMs: line.pause_after_ms ?? 0 });
        onLine?.(++done, lines.length);
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TTS_CONCURRENCY, lines.length) }, worker));
  return failed ? null : out;
}

/** Cloud audio for the script, budgeted like a Claude call; null means on-device TTS. */
async function audioFor(ctx: OperationContext, episode: EpisodeRow, requester: string, script: PodcastScriptDoc): Promise<{ path: string; results: SynthesisResult[]; provider: TtsProvider } | null> {
  const tts = ctx.tts;
  if (!tts) return null;
  const chars = script.segments.reduce((n, s) => n + s.lines.reduce((m, l) => m + speakableText(l.text).length, 0), 0);
  const budgetCtx = { userId: requester, classGroupId: episode.class_group_id, subjectId: episode.subject_id, feature: 'INT-01', budgetClass: 'user' as const };
  const reservation = await ctx.ai.budget.reserve({ ctx: budgetCtx, taskId: 'podcast.tts', promptVersion: 'tts', estimateMicroUsd: ttsCostMicroUsd(tts, chars), mode: 'sync' });
  if (!reservation.ok) {
    ctx.log.info({ episode: episode.id, scope: reservation.scope }, 'podcast tts budget refused: device audio');
    return null;
  }
  let spent = 0;
  // The voices fill 0.6–0.95 of the bar as lines are recorded, written at most every tenth of the lines and one
  // after the other, so a late write never lands after the episode is ready.
  let reported = 0;
  let writes: Promise<void> = Promise.resolve();
  const onLine = (done: number, total: number) => {
    if (done - reported < Math.max(1, Math.ceil(total / 10)) && done < total) return;
    reported = done;
    writes = writes.then(() => ctx.progress({ stage: 'audio', progress: 0.6 + (0.35 * done) / total, items_done: done, items_total: total })).catch(() => undefined);
  };
  try {
    const results = await synthesizeLines(tts, script, onLine).finally(() => writes);
    if (!results) return null;
    const billed = results.reduce((n, r) => n + r.billedChars, 0);
    spent = ttsCostMicroUsd(tts, billed);
    await ctx.ai.usage.record({
      user_id: requester,
      class_group_id: episode.class_group_id,
      subject_id: episode.subject_id,
      document_id: null,
      node_id: null,
      job_id: null,
      feature: 'INT-01',
      task_id: 'podcast.tts',
      prompt_version: 'tts',
      budget_class: 'user',
      mode: 'sync',
      model_requested: tts.id,
      model_served: tts.id,
      fallback_used: false,
      effort: 'low',
      input_tokens: billed,
      output_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      cache_read_tokens: 0,
      server_tool_uses: null,
      stop_reason: null,
      refusal_category: null,
      cost_micro_usd: spent,
      price_version: `tts:${tts.microUsdPerChar}`,
      latency_ms: 0,
      ttft_ms: null,
      request_id: null,
      batch_id: null,
      custom_id: null,
      attempt: 1,
      error_code: null,
    });
    const object = episode.owner_user_id ? `answers/${episode.owner_user_id}/${episode.id}.mp3` : `${episode.subject_id}/${episode.id}.mp3`;
    const uploaded = await ctx.supabase.storage.from('audio').upload(object, concatMp3(results.map((r) => r.audio)), { contentType: 'audio/mpeg', upsert: true });
    if (uploaded.error) throw new JobDataError(`audio upload failed: ${uploaded.error.message}`, 'storage');
    return { path: `audio/${object}`, results, provider: tts };
  } finally {
    await ctx.ai.budget.settle(reservation.reservationId, spent);
  }
}

export async function handlePodcastGenerate(ctx: OperationContext, raw: Record<string, unknown>): Promise<PodcastOutcome> {
  const payload = parsePayload(Payload, raw, 'podcast.generate');
  const episode = unwrap(
    await ctx.supabase.from('podcast_episodes').select('id,subject_id,node_ids,style,length_minutes,owner_user_id,class_group_id,status,created_by').eq('id', payload.episode_id).maybeSingle(),
    'podcast_episodes',
  ) as EpisodeRow | null;
  if (!episode) return { status: 'skipped', audio: false, reason: 'not_found' };
  if (episode.status === 'ready') return { status: 'skipped', audio: false, reason: 'already_ready' };
  const requester = payload.user_id ?? episode.created_by;

  const subject = unwrap(
    await ctx.supabase.from('subjects').select('id,name,content_language,is_language_subject').eq('id', episode.subject_id).maybeSingle(),
    'subjects',
  ) as { id: string; name: string; content_language: string | null; is_language_subject: boolean } | null;
  if (!subject) return fail(ctx, episode.id, 'subject_missing');
  unwrap(await ctx.supabase.from('podcast_episodes').update({ status: 'scripting', error_code: null }).eq('id', episode.id), 'podcast_episodes');
  await ctx.progress({ stage: 'script', status: 'running', progress: 0.1 });

  const topics = unwrapRows<TopicRow>(
    await ctx.supabase.from('knowledge_nodes').select('id,title,summary,learning_objectives').in('id', episode.node_ids).is('deleted_at', null),
    'knowledge_nodes',
  );
  if (topics.length === 0) return fail(ctx, episode.id, 'no_topics');

  // Weights: Revisão pra prova by 1 − mastery of the owner; the other styles weigh topics equally (§8.2).
  const weights = new Map(topics.map((t) => [t.id, 1]));
  let weakConcepts: string[] = [];
  let recentMistakes: string[] = [];
  if (episode.style === 'exam_review' && episode.owner_user_id) {
    const mastery = unwrapRows<{ node_id: string; mastery: number }>(
      await ctx.supabase.from('mastery').select('node_id,mastery').eq('user_id', episode.owner_user_id).in('node_id', episode.node_ids),
      'mastery',
    );
    for (const m of mastery) weights.set(m.node_id, 1 - Number(m.mastery));
    const concepts = unwrapRows<{ id: string; title: string; parent_id: string }>(
      await ctx.supabase.from('knowledge_nodes').select('id,title,parent_id').in('parent_id', episode.node_ids).eq('kind', 'concept').is('deleted_at', null),
      'knowledge_nodes',
    );
    const conceptMastery = unwrapRows<{ node_id: string; mastery: number }>(
      await ctx.supabase.from('mastery').select('node_id,mastery').eq('user_id', episode.owner_user_id).in('node_id', concepts.map((c) => c.id)),
      'mastery',
    );
    weakConcepts = conceptMastery
      .filter((m) => Number(m.mastery) < 0.6)
      .sort((a, b) => Number(a.mastery) - Number(b.mastery))
      .slice(0, 6)
      .map((m) => concepts.find((c) => c.id === m.node_id)?.title ?? '')
      .filter(Boolean);
    const mistakes = unwrapRows<{ node_id: string | null }>(
      await ctx.supabase.from('mistakes').select('node_id').eq('user_id', episode.owner_user_id).in('node_id', episode.node_ids).is('resolved_at', null).limit(20),
      'mistakes',
    );
    recentMistakes = [...new Set(mistakes.map((m) => topics.find((t) => t.id === m.node_id)?.title).filter((v): v is string => !!v))];
  }
  const allocation = allocatePodcastTopics(topics.map((t) => ({ node_id: t.id, title: t.title, weight: weights.get(t.id) ?? 1 })), episode.length_minutes);
  const included = allocation.included;

  const notes = unwrapRows<{ node_id: string; body: string }>(
    await ctx.supabase.from('notes').select('node_id,body').in('node_id', included.map((t) => t.node_id)).eq('depth', episode.style === 'deep' ? 'deep' : 'study').eq('status', 'ready').is('deleted_at', null),
    'notes',
  );
  const glossary = unwrapRows<{ term: string; definition: string }>(
    await ctx.supabase.from('glossary_terms').select('term,definition').in('node_id', included.map((t) => t.node_id)).is('deleted_at', null).limit(20),
    'glossary_terms',
  );
  const keyToNode = new Map<string, string>();
  const topicInputs = included.map((t, i) => {
    const row = topics.find((x) => x.id === t.node_id)!;
    keyToNode.set(`t${i + 1}`, t.node_id);
    return {
      key: `t${i + 1}`,
      title: row.title,
      summary: row.summary ?? '',
      objectives: row.learning_objectives ?? [],
      concepts: [],
      words: t.words,
      notes: (notes.find((n) => n.node_id === t.node_id)?.body ?? '').slice(0, 5000),
    };
  });
  const slices = await topicSlices(ctx, included.map((t) => t.node_id));
  if (slices.length === 0) return fail(ctx, episode.id, 'no_material');

  const targetWords = podcastTargetWords(episode.length_minutes);
  const input = {
    subjectName: subject.name,
    style: episode.style,
    lengthMinutes: episode.length_minutes,
    targetWords,
    frame: allocation.frame,
    topics: topicInputs,
    glossary,
    weakConcepts,
    recentMistakes,
    dropped: allocation.dropped.map((d) => d.title),
    slices,
    contentLanguage: subject.content_language ?? 'pt-BR',
    languageSubject: subject.is_language_subject,
  };

  // One paid call for the script (no retry). The word budget is a target, not a contract: a miss on length alone
  // still makes a usable episode.
  let script: PodcastScriptDoc | null = null;
  let issues: string[] = [];
  let outcome;
  try {
    outcome = await runPrompt(ctx.ai, {
      task: getTask('podcast.script'),
      schema: PodcastScriptSchema as unknown as z.ZodType<ModelScript>,
      input,
      scope: { userId: requester, classGroupId: episode.class_group_id, subjectId: subject.id, jobId: payload.ai_job_id ?? null, feature: 'INT-01' },
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) return fail(ctx, episode.id, 'budget_exceeded');
    throw err;
  }
  if (outcome.result.status !== 'ok') {
    issues = [outcome.result.status];
  } else {
    const mapped = mapScript(outcome.result.data as ModelScript, keyToNode, outcome.documents);
    issues = validatePodcastScript(mapped, { targetWords, pageAllowed: pageAllowedIn(outcome.documents) });
    if (issues.every((i) => i.startsWith('word count'))) script = mapped;
  }
  if (!script) {
    ctx.log.warn({ episode: episode.id, issues: issues.slice(0, 5) }, 'podcast script invalid');
    return fail(ctx, episode.id, 'script_invalid');
  }

  unwrap(await ctx.supabase.from('podcast_episodes').update({ status: 'synthesizing', title: script.title, script }).eq('id', episode.id), 'podcast_episodes');
  await ctx.progress({ stage: 'audio', progress: 0.6 });
  const audio = await audioFor(ctx, episode, requester, script).catch((err: unknown) => {
    ctx.log.warn({ episode: episode.id, err: err instanceof Error ? err.message : 'unknown' }, 'podcast tts failed: device audio');
    return null;
  });
  const timeline = buildPodcastTimeline(script, audio ? audio.results.map((r) => r.durationMs) : []);
  unwrap(
    await ctx.supabase
      .from('podcast_episodes')
      .update({
        status: 'ready',
        audio_path: audio?.path ?? null,
        duration_ms: timeline.duration_ms,
        chapters: timeline.chapters,
        line_timings: timeline.line_timings,
        voices: audio ? { provider: audio.provider.id, ...audio.provider.voices } : { provider: 'device' },
      })
      .eq('id', episode.id),
    'podcast_episodes',
  );
  await ctx.progress({ stage: 'done', status: 'succeeded', progress: 1 });
  await ctx.execute('notify.dispatch', { user_id: requester, type: 'podcast_ready', data: { episode_id: episode.id } }, { singletonKey: `podcast_ready:${episode.id}` });
  return { status: 'ready', audio: audio !== null };
}

export const jobs: OperationDefinition<any>[] = [
  {
    name: 'podcast.generate',
    handler: async (ctx, data) => {
      const outcome = await handlePodcastGenerate(ctx, data);
      ctx.log.info(outcome, 'podcast.generate finished');
    },
  },
];

