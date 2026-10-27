import { describe, expect, it } from 'vitest';
import {
  allocatePodcastTopics,
  buildPodcastTimeline,
  countWords,
  estimateLineDurationMs,
  maxPodcastTopics,
  parseHostLines,
  podcastCacheKey,
  podcastTargetWords,
  resumeAfterHand,
  scriptWordCount,
  segmentAt,
  stableHashHex,
  transcriptBefore,
  validatePodcastScript,
  type PodcastScriptDoc,
} from '../../src/interactive/index.ts';

const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ');

function script(totalWords: number, overrides: Partial<PodcastScriptDoc> = {}): PodcastScriptDoc {
  const perLine = 50;
  const lines = Math.ceil(totalWords / perLine);
  return {
    title: 'Episódio',
    segments: [
      {
        id: 's1',
        kind: 'topic',
        node_ids: ['n1'],
        title: 'Genética',
        source_pages: [{ document_id: 'd1', page_start: 2, page_end: 3 }],
        lines: Array.from({ length: lines }, (_, i) => ({
          speaker: i % 2 === 0 ? ('bia' as const) : ('caio' as const),
          text: words(i === lines - 1 ? totalWords - perLine * (lines - 1) : perLine),
        })),
      },
    ],
    ...overrides,
  };
}

describe('episode sizing (spec 12 §8.2, learning-engine §19.2)', () => {
  it('targets 150 words per minute and 6 topics per 10 minutes', () => {
    expect(podcastTargetWords(5)).toBe(750);
    expect(podcastTargetWords(10)).toBe(1500);
    expect(podcastTargetWords(15)).toBe(2250);
    expect(maxPodcastTopics(5)).toBe(3);
    expect(maxPodcastTopics(10)).toBe(6);
    expect(maxPodcastTopics(15)).toBe(9);
  });

  it('keeps the heaviest topics, drops the rest and splits words by weight', () => {
    const topics = [
      { node_id: 'a', title: 'A', weight: 0.1 },
      { node_id: 'b', title: 'B', weight: 0.6 },
      { node_id: 'c', title: 'C', weight: 0.3 },
      { node_id: 'd', title: 'D', weight: 0.05 },
    ];
    const plan = allocatePodcastTopics(topics, 5);
    expect(plan.included.map((t) => t.node_id)).toEqual(['b', 'c', 'a']);
    expect(plan.dropped).toEqual([{ node_id: 'd', title: 'D' }]);
    const topicWords = Math.round(750 * 0.78);
    expect(plan.included[0]!.words).toBe(Math.round((topicWords * 0.6) / 1.0));
    expect(plan.frame).toEqual({ hook: 23, agenda: 23, recap: 60, quickfire: 45, outro: 15 });
  });
});

describe('validatePodcastScript (ai-pipeline podcast.script)', () => {
  it('accepts a script within ±15% of the target', () => {
    expect(validatePodcastScript(script(1500), { targetWords: 1500 })).toEqual([]);
    expect(validatePodcastScript(script(1290), { targetWords: 1500 })).toEqual([]);
  });

  it('rejects scripts outside ±15%', () => {
    expect(validatePodcastScript(script(1200), { targetWords: 1500 })[0]).toMatch(/word count 1200/);
    expect(validatePodcastScript(script(1800), { targetWords: 1500 })[0]).toMatch(/word count 1800/);
  });

  it('rejects long lines, long runs of one host and pages outside the material', () => {
    const bad = script(1500);
    bad.segments[0]!.lines[0]!.text = words(61);
    bad.segments[0]!.lines.forEach((l) => (l.speaker = 'bia'));
    const issues = validatePodcastScript(bad, { targetWords: 1500, pageAllowed: (_d, page) => page < 3 });
    expect(issues.some((i) => i.includes('over 60 words'))).toBe(true);
    expect(issues.some((i) => i.includes('more than 4 lines'))).toBe(true);
    expect(issues.some((i) => i.includes('outside the material'))).toBe(true);
  });

  it('requires a topic segment with pages', () => {
    const noPages = script(1500);
    noPages.segments[0]!.source_pages = [];
    expect(validatePodcastScript(noPages, { targetWords: 1500 })).toContain('topic segment s1 has no source page');
    const noTopic = script(1500);
    noTopic.segments[0]!.kind = 'recap';
    expect(validatePodcastScript(noTopic, { targetWords: 1500 })).toContain('no topic segment');
  });

  it('counts words, not punctuation', () => {
    expect(countWords('Oi, tudo bem? — sim!')).toBe(4);
    expect(scriptWordCount(script(77))).toBe(77);
  });
});

describe('cache key (§8.4)', () => {
  const base = { subjectId: 's', nodeIds: ['b', 'a'], style: 'overview' as const, lengthMinutes: 10, notesVersion: 3 };
  it('is order-insensitive for nodes and stable', () => {
    expect(podcastCacheKey(base)).toBe(podcastCacheKey({ ...base, nodeIds: ['a', 'b', 'a'] }));
    expect(podcastCacheKey(base)).toMatch(/^[0-9a-f]{32}$/);
  });
  it('changes with notes version, style, owner and voices', () => {
    const key = podcastCacheKey(base);
    expect(podcastCacheKey({ ...base, notesVersion: 4 })).not.toBe(key);
    expect(podcastCacheKey({ ...base, style: 'deep' })).not.toBe(key);
    expect(podcastCacheKey({ ...base, ownerUserId: 'u' })).not.toBe(key);
    expect(podcastCacheKey({ ...base, voices: 'device' })).not.toBe(key);
  });
  it('hashes deterministically', () => {
    expect(stableHashHex('abc')).toBe(stableHashHex('abc'));
    expect(stableHashHex('abc')).not.toBe(stableHashHex('abd'));
  });
});

describe('✋ answers and timeline (§7.4, §8.3)', () => {
  it('parses BIA/CAIO prefixes, continuations and unprefixed text', () => {
    expect(parseHostLines('BIA: Alelo é uma versão do gene.\nCAIO: Tipo olho azul ou castanho?\ncontinua aqui\nbia: Isso!')).toEqual([
      { speaker: 'bia', text: 'Alelo é uma versão do gene.' },
      { speaker: 'caio', text: 'Tipo olho azul ou castanho? continua aqui' },
      { speaker: 'bia', text: 'Isso!' },
    ]);
    expect(parseHostLines('Resposta sem prefixo.')).toEqual([{ speaker: 'bia', text: 'Resposta sem prefixo.' }]);
    expect(parseHostLines('**CAIO:** oi')).toEqual([{ speaker: 'caio', text: 'oi' }]);
  });

  it('resumes 3 s before the pause point', () => {
    expect(resumeAfterHand(65_000)).toBe(62_000);
    expect(resumeAfterHand(1_000)).toBe(0);
  });

  it('builds chapters and line timings from measured or estimated durations', () => {
    const s: PodcastScriptDoc = {
      title: 't',
      segments: [
        { id: 'h', kind: 'hook', node_ids: [], title: 'Abertura', source_pages: [], lines: [{ speaker: 'bia', text: 'Oi!' }] },
        { id: 't1', kind: 'topic', node_ids: ['n'], title: 'Tema', source_pages: [], lines: [{ speaker: 'caio', text: 'E aí?' }, { speaker: 'bia', text: 'Bora.', pause_after_ms: 500 }] },
      ],
    };
    const timeline = buildPodcastTimeline(s, [1000, 2000]);
    expect(timeline.chapters).toEqual([
      { segment_id: 'h', start_ms: 0, title: 'Abertura' },
      { segment_id: 't1', start_ms: 1000, title: 'Tema' },
    ]);
    const estimated = estimateLineDurationMs({ text: 'Bora.', pause_after_ms: 500 });
    expect(timeline.duration_ms).toBe(3000 + estimated);
    expect(segmentAt(timeline.line_timings, 2500)).toBe('t1');
    expect(segmentAt(timeline.line_timings, 10)).toBe('h');
    expect(transcriptBefore(s, timeline.line_timings, 1500)).toBe('BIA: Oi!\nCAIO: E aí?');
  });
});
