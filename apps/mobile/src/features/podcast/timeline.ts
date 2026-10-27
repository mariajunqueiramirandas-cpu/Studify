// Player timeline (INT-01.7, INT-01.12): the episode's lines flattened with their start/end times, the line
// playing at a position, and the "Pausa pra pensar" window. Pure, shared by the cloud and the on-device player.
import { RECALL_PAUSE_MS, buildPodcastTimeline, type LineTiming, type PodcastScriptDoc } from '@studify/shared';

export interface TimelineLine {
  index: number;
  segmentId: string;
  speaker: 'bia' | 'caio';
  text: string;
  /** Silence after the line (pause_after_ms), part of [startMs, endMs). */
  pauseMs: number;
  startMs: number;
  endMs: number;
}

/** Lines in play order. Stored timings (measured audio) win; otherwise they are estimated from the words. */
export function flattenTimeline(script: Pick<PodcastScriptDoc, 'segments'>, timings: readonly LineTiming[] | null | undefined): TimelineLine[] {
  const t = timings && timings.length ? timings : buildPodcastTimeline(script).line_timings;
  const out: TimelineLine[] = [];
  let i = 0;
  for (const segment of script.segments) {
    segment.lines.forEach((line, lineIndex) => {
      const timing = t.find((x) => x.segment_id === segment.id && x.line_index === lineIndex);
      const prev = out[out.length - 1];
      const startMs = timing?.start_ms ?? prev?.endMs ?? 0;
      out.push({
        index: i++,
        segmentId: segment.id,
        speaker: line.speaker,
        text: line.text,
        pauseMs: line.pause_after_ms ?? 0,
        startMs,
        endMs: timing?.end_ms ?? startMs,
      });
    });
  }
  return out;
}

/** Index of the line playing at `positionMs` (the last line that started), or 0. */
export function lineAt(lines: readonly TimelineLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Seconds left in a "Pausa pra pensar" (INT-01.12) at `positionMs`, or null outside one. Only pauses of at least
 * the recall pause count: shorter ones are breathing room, not a question to the listener.
 */
export function thinkCountdown(lines: readonly TimelineLine[], positionMs: number): number | null {
  const line = lines[lineAt(lines, positionMs)];
  if (!line || line.pauseMs < RECALL_PAUSE_MS) return null;
  const pauseStart = line.endMs - line.pauseMs;
  if (positionMs < pauseStart || positionMs >= line.endMs) return null;
  return Math.max(1, Math.ceil((line.endMs - positionMs) / 1000));
}

/** "Fontes" (INT-01.7): every page cited by the episode, one entry per document range. */
export function episodeSources(script: Pick<PodcastScriptDoc, 'segments'>): { document_id: string; page_start: number; page_end: number }[] {
  const seen = new Set<string>();
  const out: { document_id: string; page_start: number; page_end: number }[] = [];
  for (const s of script.segments) {
    for (const p of s.source_pages) {
      const key = `${p.document_id}:${p.page_start}:${p.page_end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ document_id: p.document_id, page_start: p.page_start, page_end: p.page_end ?? p.page_start });
    }
  }
  return out;
}
