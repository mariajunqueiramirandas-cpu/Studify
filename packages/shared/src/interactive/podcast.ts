// Podcast Interativo (INT-01): episode sizing (spec 12 §8.2, learning-engine §19.2), script validation
// (ai-pipeline `podcast.script`), the reuse cache key (§8.4), ✋ answer parsing (§7.4) and the playback
// timeline (chapters, synced transcript). Pure functions shared by the API, the worker and the app.
import type { PodcastLength, PodcastStyle } from '../core/enums.ts';
import type { SourcePage } from '../core/citations.ts';
import { stableHashHex } from './hash.ts';

/** PT-BR conversational speech (spec 12 §8.2). */
export const PODCAST_WORDS_PER_MINUTE = 150;

/** Share of the words per segment kind (spec 12 §8.2). */
export const PODCAST_SHARES = { hook: 0.03, agenda: 0.03, topics: 0.78, recap: 0.08, quickfire: 0.06, outro: 0.02 } as const;

/** ±15% word budget (ai-pipeline `podcast.script` validation). */
export const PODCAST_WORD_TOLERANCE = 0.15;
/** No line longer than 60 words; no host speaks more than 4 lines in a row. */
export const PODCAST_MAX_LINE_WORDS = 60;
export const PODCAST_MAX_SAME_SPEAKER_RUN = 4;

/** INT-01.8, §8.3: ✋ limits and behaviour. */
export const HAND_DAILY_CAP = 10;
export const HAND_RESUME_REWIND_MS = 3000;
export const HAND_ANSWER_MAX_WORDS = 110;
export const HAND_TTS_TIMEOUT_MS = 6000;
/** INT-01.12 "Pausa pra pensar". */
export const RECALL_PAUSE_MS = 5000;

/** Bumped when the script prompt or structure changes; part of the cache key (§8.4). */
export const PODCAST_SCRIPT_VERSION = 1;

export type PodcastSpeaker = 'bia' | 'caio';
export type PodcastSegmentKind = 'hook' | 'agenda' | 'topic' | 'recap' | 'quickfire' | 'outro';

export interface PodcastLine {
  speaker: PodcastSpeaker;
  text: string;
  pause_after_ms?: number | null;
  emphasis?: string[] | null;
}

export interface PodcastSegment {
  id: string;
  kind: PodcastSegmentKind;
  node_ids: string[];
  title: string;
  lines: PodcastLine[];
  source_pages: SourcePage[];
  recall_question?: { question: string; answer: string } | null;
}

export interface PodcastScriptDoc {
  title: string;
  segments: PodcastSegment[];
}

export function podcastTargetWords(minutes: PodcastLength | number): number {
  return PODCAST_WORDS_PER_MINUTE * minutes;
}

/** Spec 12 §8.2: at most 6 topics per 10 minutes. */
export function maxPodcastTopics(minutes: PodcastLength | number): number {
  return Math.max(1, Math.floor((6 * minutes) / 10));
}

export interface PodcastTopicInput {
  node_id: string;
  title: string;
  /** Exam scope weight, or 1 − mastery for "Revisão pra prova". */
  weight: number;
}

export interface PodcastAllocation {
  included: { node_id: string; title: string; words: number }[];
  /** "Ficou de fora: …" (spec 12 §8.2). */
  dropped: { node_id: string; title: string }[];
  /** Word targets per non-topic segment kind. */
  frame: Record<Exclude<PodcastSegmentKind, 'topic'>, number>;
  targetWords: number;
}

/**
 * Picks the topics of an episode by weight (ties by title, then id) and splits the topic words among them
 * in proportion to the weight. A topic always gets at least 40 words so no segment is empty.
 */
export function allocatePodcastTopics(topics: readonly PodcastTopicInput[], minutes: PodcastLength | number): PodcastAllocation {
  const targetWords = podcastTargetWords(minutes);
  const sorted = [...topics].sort(
    (a, b) => b.weight - a.weight || a.title.localeCompare(b.title, 'pt-BR') || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0),
  );
  const max = maxPodcastTopics(minutes);
  const included = sorted.slice(0, max);
  const dropped = sorted.slice(max).map(({ node_id, title }) => ({ node_id, title }));
  const topicWords = Math.round(targetWords * PODCAST_SHARES.topics);
  const weights = included.map((t) => Math.max(0.05, Number.isFinite(t.weight) ? t.weight : 0));
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  return {
    included: included.map((t, i) => ({ node_id: t.node_id, title: t.title, words: Math.max(40, Math.round((topicWords * weights[i]!) / total)) })),
    dropped,
    frame: {
      hook: Math.round(targetWords * PODCAST_SHARES.hook),
      agenda: Math.round(targetWords * PODCAST_SHARES.agenda),
      recap: Math.round(targetWords * PODCAST_SHARES.recap),
      quickfire: Math.round(targetWords * PODCAST_SHARES.quickfire),
      outro: Math.round(targetWords * PODCAST_SHARES.outro),
    },
    targetWords,
  };
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length;
}

export function scriptWordCount(script: Pick<PodcastScriptDoc, 'segments'>): number {
  return script.segments.reduce((sum, seg) => sum + seg.lines.reduce((s, line) => s + countWords(line.text), 0), 0);
}

export interface ScriptValidationOptions {
  targetWords: number;
  /** True when the page is inside the slices sent for this episode (TRU-01). */
  pageAllowed?: (documentId: string, page: number) => boolean;
}

/**
 * ai-pipeline `podcast.script` validation: total words within ±15% of the target; every topic segment cites
 * at least one page inside the provided slices; no line over 60 words; no host speaks more than 4 lines in a
 * row; segment ids unique; at least one topic segment. Returns the issues (empty = valid).
 */
export function validatePodcastScript(script: PodcastScriptDoc, options: ScriptValidationOptions): string[] {
  const issues: string[] = [];
  const words = scriptWordCount(script);
  const lo = Math.floor(options.targetWords * (1 - PODCAST_WORD_TOLERANCE));
  const hi = Math.ceil(options.targetWords * (1 + PODCAST_WORD_TOLERANCE));
  if (words < lo || words > hi) issues.push(`word count ${words} outside ${lo}–${hi}`);
  if (!script.segments.some((s) => s.kind === 'topic')) issues.push('no topic segment');
  const ids = new Set<string>();
  let run = 0;
  let last: PodcastSpeaker | null = null;
  for (const segment of script.segments) {
    if (ids.has(segment.id)) issues.push(`duplicate segment id ${segment.id}`);
    ids.add(segment.id);
    if (segment.lines.length === 0) issues.push(`segment ${segment.id} has no lines`);
    if (segment.kind === 'topic') {
      if (segment.source_pages.length === 0) issues.push(`topic segment ${segment.id} has no source page`);
      if (options.pageAllowed) {
        for (const p of segment.source_pages) {
          for (let page = p.page_start; page <= p.page_end; page++) {
            if (!options.pageAllowed(p.document_id, page)) {
              issues.push(`segment ${segment.id} cites a page outside the material (${page})`);
              break;
            }
          }
        }
      }
    }
    for (const line of segment.lines) {
      if (countWords(line.text) > PODCAST_MAX_LINE_WORDS) issues.push(`segment ${segment.id} has a line over ${PODCAST_MAX_LINE_WORDS} words`);
      run = line.speaker === last ? run + 1 : 1;
      last = line.speaker;
      if (run === PODCAST_MAX_SAME_SPEAKER_RUN + 1) issues.push(`segment ${segment.id}: ${line.speaker} speaks more than ${PODCAST_MAX_SAME_SPEAKER_RUN} lines in a row`);
    }
  }
  return [...new Set(issues)];
}

export interface PodcastCacheKeyInput {
  subjectId: string;
  nodeIds: readonly string[];
  style: PodcastStyle;
  lengthMinutes: number;
  /** max(notes.version) of the scope nodes (§8.4). */
  notesVersion: number;
  scriptVersion?: number;
  /** Personal episodes (exam_review) include the owner so they are never shared. */
  ownerUserId?: string | null;
  /** Voices change the audio, so they are part of the key. */
  voices?: string | null;
}

/** §8.4: hash(subject, sorted nodes, style, length, script version, notes version[, owner, voices]). */
export function podcastCacheKey(input: PodcastCacheKeyInput): string {
  const parts = [
    'podcast',
    input.subjectId,
    [...new Set(input.nodeIds)].sort().join(','),
    input.style,
    String(input.lengthMinutes),
    `s${input.scriptVersion ?? PODCAST_SCRIPT_VERSION}`,
    `n${input.notesVersion}`,
    input.ownerUserId ?? '',
    input.voices ?? '',
  ];
  return stableHashHex(parts.join('|'));
}

/**
 * Spec 12 §7.4: the ✋ answer arrives as lines prefixed "BIA:" / "CAIO:". Unprefixed text continues the
 * previous speaker; with no prefix at all the whole text is Bia's.
 */
export function parseHostLines(text: string): PodcastLine[] {
  const out: PodcastLine[] = [];
  let current: PodcastLine | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^\**\s*(BIA|CAIO)\s*\**\s*[:：]\s*\**\s*(.*)$/i.exec(line);
    if (match) {
      current = { speaker: match[1]!.toLowerCase() === 'caio' ? 'caio' : 'bia', text: match[2]!.trim() };
      out.push(current);
    } else if (current) {
      current.text = `${current.text} ${line}`.trim();
    } else {
      current = { speaker: 'bia', text: line };
      out.push(current);
    }
  }
  return out.filter((l) => l.text.length > 0);
}

/** INT-01.8: resume 3 s before the pause point. */
export function resumeAfterHand(positionMs: number): number {
  return Math.max(0, Math.round(positionMs) - HAND_RESUME_REWIND_MS);
}

/** Estimated speaking time of a line at the PT-BR pace, plus its pause (device-TTS episodes, §8.2). */
export function estimateLineDurationMs(line: Pick<PodcastLine, 'text' | 'pause_after_ms'>, wordsPerMinute = PODCAST_WORDS_PER_MINUTE): number {
  const words = Math.max(1, countWords(line.text));
  return Math.round((words / wordsPerMinute) * 60_000) + Math.max(0, line.pause_after_ms ?? 0);
}

export interface LineTiming {
  segment_id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
}

export interface PodcastChapter {
  segment_id: string;
  start_ms: number;
  title: string;
}

export interface PodcastTimeline {
  chapters: PodcastChapter[];
  line_timings: LineTiming[];
  duration_ms: number;
}

/**
 * Chapters (one per segment) and line timings for the synced transcript. `durationsMs` are the measured
 * durations of the synthesized lines in script order; missing entries fall back to the estimate.
 */
export function buildPodcastTimeline(script: Pick<PodcastScriptDoc, 'segments'>, durationsMs: readonly number[] = []): PodcastTimeline {
  const chapters: PodcastChapter[] = [];
  const timings: LineTiming[] = [];
  let at = 0;
  let index = 0;
  for (const segment of script.segments) {
    chapters.push({ segment_id: segment.id, start_ms: at, title: segment.title });
    segment.lines.forEach((line, lineIndex) => {
      const measured = durationsMs[index];
      const duration = measured !== undefined && Number.isFinite(measured) && measured >= 0 ? Math.round(measured) : estimateLineDurationMs(line);
      timings.push({ segment_id: segment.id, line_index: lineIndex, start_ms: at, end_ms: at + duration });
      at += duration;
      index++;
    });
  }
  return { chapters, line_timings: timings, duration_ms: at };
}

/** The segment playing at `positionMs` (the ✋ context, spec 12 §7.4). */
export function segmentAt(timings: readonly LineTiming[], positionMs: number): string | null {
  let found: string | null = timings[0]?.segment_id ?? null;
  for (const t of timings) {
    if (t.start_ms <= positionMs) found = t.segment_id;
    else break;
  }
  return found;
}

/** Lines spoken in the ~60 s before `positionMs`, as plain transcript (✋ context). */
export function transcriptBefore(script: Pick<PodcastScriptDoc, 'segments'>, timings: readonly LineTiming[], positionMs: number, windowMs = 60_000): string {
  const bySegment = new Map(script.segments.map((s) => [s.id, s] as const));
  return timings
    .filter((t) => t.end_ms > positionMs - windowMs && t.start_ms <= positionMs)
    .map((t) => {
      const line = bySegment.get(t.segment_id)?.lines[t.line_index];
      return line ? `${line.speaker === 'bia' ? 'BIA' : 'CAIO'}: ${line.text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}
