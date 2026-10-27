// podcast-ask (INT-01.8–01.11; api §4.8). The ✋ button: the hosts answer a question in the context of the
// segment that was playing, grounded in that segment's pages (Citations API), in 2–4 lines "BIA:" / "CAIO:".
// The text streams first; the audio is synthesized afterwards with the cloud voices, and when the provider is
// missing or slower than 6 s the app reads the lines with on-device TTS (tts_fallback). Max 10 per day.
import {
  ApiFailure,
  DEFAULT_TIME_ZONE,
  HAND_DAILY_CAP,
  HAND_TTS_TIMEOUT_MS,
  PodcastAskReqSchema,
  buildPodcastTimeline,
  parseHostLines,
  resumeAfterHand,
  segmentAt,
  transcriptBefore,
  type PodcastAskReq,
  type PodcastScriptDoc,
  type LineTiming,
} from '@studify/shared';
import { HAND_OUT_OF_MATERIAL, getTask, type PdfSlice } from '@studify/prompts';
import { concatMp3, ttsCostMicroUsd } from '@studify/speech';
import { defineP2 } from '../shared-p2/http.ts';
import type { P2Deps } from '../shared-p2/deps.ts';
import { requireSubject } from '../shared/access.ts';
import { citationsForStorage, openStream, toTaskCall } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { prepareSlices, toPdfSlice } from '../shared/slices.ts';
import { pumpStream, stopReasonOf } from '../shared/stream.ts';
import { startOfLocalDay } from './tutor-chat.ts';

interface EpisodeRow {
  id: string;
  subject_id: string;
  owner_user_id: string | null;
  title: string | null;
  status: string;
  script: PodcastScriptDoc | null;
  line_timings: LineTiming[] | null;
}

async function segmentSlices(p2: P2Deps, script: PodcastScriptDoc, index: number): Promise<PdfSlice[]> {
  // The segment's own pages, else the nearest topic segment's (hook, agenda and recap cite none).
  const order = [index, index + 1, index - 1, index + 2, index - 2];
  const refs = order.map((i) => script.segments[i]).find((s) => s && s.source_pages.length > 0)?.source_pages ?? [];
  const byDoc = new Map<string, number[]>();
  let budget = 6;
  for (const ref of refs) {
    const list = byDoc.get(ref.document_id) ?? [];
    for (let p = ref.page_start; p <= ref.page_end && budget > 0; p++, budget--) list.push(p);
    byDoc.set(ref.document_id, list);
  }
  const out: PdfSlice[] = [];
  for (const [documentId, pages] of byDoc) {
    const doc = await p2.db.from('documents').select('title, storage_path, deleted_at').eq('id', documentId).maybeSingle();
    if (doc.error) throw doc.error;
    if (!doc.data || doc.data.deleted_at) continue;
    const prepared = await prepareSlices(p2.db, { documentId, title: doc.data.title as string, storagePath: doc.data.storage_path as string, pages, purpose: 'tutor', newId: p2.newId });
    out.push(...prepared.map(toPdfSlice));
  }
  return out;
}

/** Cloud audio for the answer lines, or null (fallback to on-device TTS) when missing, failing or too slow. */
async function synthesizeAnswer(p2: P2Deps, userId: string, interactionId: string, lines: Array<{ speaker: 'bia' | 'caio'; text: string }>): Promise<string | null> {
  const tts = p2.tts;
  if (!tts || !p2.uploadObject || !p2.signedUrl || lines.length === 0) return null;
  // TTS spend goes through the same budget gate as Claude (ai-pipeline §12); a refusal means device audio.
  const estimate = ttsCostMicroUsd(tts, lines.reduce((n, l) => n + l.text.length + 20, 0));
  const reservation = await p2.ai.budget.reserve({
    ctx: { userId, classGroupId: null, feature: 'INT-01', budgetClass: 'user' },
    taskId: 'podcast.handTts',
    promptVersion: 'tts',
    estimateMicroUsd: estimate,
    mode: 'sync',
  });
  if (!reservation.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HAND_TTS_TIMEOUT_MS);
  let spent = 0;
  try {
    const parts = await Promise.all(lines.map((l) => tts.synthesize({ text: l.text, voice: l.speaker }, { signal: controller.signal })));
    const chars = parts.reduce((n, p) => n + p.billedChars, 0);
    spent = ttsCostMicroUsd(tts, chars);
    await p2.ai.usage.record({
      user_id: userId,
      class_group_id: null,
      subject_id: null,
      document_id: null,
      node_id: null,
      job_id: null,
      feature: 'INT-01',
      task_id: 'podcast.handTts',
      prompt_version: 'tts',
      budget_class: 'user',
      mode: 'sync',
      model_requested: tts.id,
      model_served: tts.id,
      fallback_used: false,
      effort: 'low',
      input_tokens: chars,
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
    const path = `audio/answers/${userId}/${interactionId}.mp3`;
    await p2.uploadObject(path, concatMp3(parts.map((p) => p.audio)), 'audio/mpeg');
    return await p2.signedUrl(path, 3600);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await p2.ai.budget.settle(reservation.reservationId, spent);
  }
}

export const handler = defineP2<PodcastAskReq>({
  name: 'podcast-ask',
  mutating: true,
  aiCall: true,
  input: PodcastAskReqSchema,
  run: async (ctx) => {
    const { p2, input } = ctx;
    const { db } = p2;
    const userId = ctx.user.userId;
    const res = await db.from('podcast_episodes').select('id, subject_id, owner_user_id, title, status, script, line_timings').eq('id', input.episode_id).maybeSingle();
    if (res.error) throw res.error;
    const episode = res.data as EpisodeRow | null;
    if (!episode || (episode.owner_user_id && episode.owner_user_id !== userId)) throw new ApiFailure('not_found');
    const subject = await requireSubject(db, userId, episode.subject_id, 'read');
    if (episode.status !== 'ready' || !episode.script) throw new ApiFailure('invalid_request', { message: 'O episódio ainda está sendo gravado.' });

    const asked = await db
      .from('podcast_interactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('episode_id', episode.id)
      .gte('created_at', startOfLocalDay(ctx.now, DEFAULT_TIME_ZONE));
    if (asked.error) throw asked.error;
    if ((asked.count ?? 0) >= HAND_DAILY_CAP) {
      throw new ApiFailure('rate_limited', { message: 'Você já fez 10 perguntas nesse episódio hoje. Pergunta pro tutor!', details: { open_tutor: true } });
    }

    const script = episode.script;
    const timings = episode.line_timings ?? buildPodcastTimeline(script).line_timings;
    const segmentId = input.segment_id ?? segmentAt(timings, input.position_ms) ?? script.segments[0]?.id ?? 'seg1';
    const index = Math.max(0, script.segments.findIndex((s) => s.id === segmentId));
    const context = script.segments
      .slice(Math.max(0, index - 1), index + 2)
      .flatMap((s) => s.lines.map((l) => `${l.speaker === 'bia' ? 'BIA' : 'CAIO'}: ${l.text}`))
      .join('\n');
    const slices = await segmentSlices(p2, script, index);
    const built = getTask('podcast.handAnswer').build({
      episodeTitle: episode.title ?? script.title,
      segmentContext: context,
      recentTranscript: transcriptBefore(script, timings, input.position_ms),
      question: input.question_text,
      slices,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const session = await openStream(claudeDepsFor(p2), toTaskCall({ built, taskId: 'podcast.handAnswer', ctx: budgetCtxFor(subject, userId, 'INT-01', 'user') }));
    const interactionId = p2.newId();
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, interaction_id: interactionId });
      const { result } = await pumpStream(writer, session);
      if (result.status !== 'ok' && result.status !== 'truncated') {
        writer.send('done', { stop_reason: stopReasonOf(result.status), usage_pct_today: await ctx.usagePct() });
        return;
      }
      const lines = parseHostLines(result.text).filter((l) => l.text.length > 0).map((l) => ({ speaker: l.speaker, text: l.text }));
      const outOfMaterial = result.text.toLowerCase().includes(HAND_OUT_OF_MATERIAL.toLowerCase());
      const citations = citationsForStorage(result.citations);
      writer.send('status', { key: 'podcast.recording_answer' });
      const audioUrl = await synthesizeAnswer(p2, userId, interactionId, lines);
      const saved = await db.from('podcast_interactions').insert({
        id: interactionId,
        user_id: userId,
        episode_id: episode.id,
        position_ms: input.position_ms,
        segment_id: segmentId,
        question_text: input.question_text,
        input_mode: input.input_mode,
        answer_lines: lines,
        citations,
        out_of_material: outOfMaterial,
        answer_audio_path: audioUrl ? `audio/answers/${userId}/${interactionId}.mp3` : null,
        tts_fallback: audioUrl === null,
      });
      if (saved.error) throw saved.error;
      writer.send('done', {
        stop_reason: stopReasonOf(result.status),
        usage_pct_today: await ctx.usagePct(),
        result: { interaction_id: interactionId, lines, out_of_material: outOfMaterial, answer_audio_url: audioUrl, tts_fallback: audioUrl === null, resume_at_ms: resumeAfterHand(input.position_ms), citations },
      });
    });
  },
});

export default handler;
