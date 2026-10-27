import { describe, expect, it } from 'vitest';
import { buildPagesCustomId, buildTopicCustomId, expandKinds, parsePagesCustomId, parseTopicCustomId } from '../../src/ingest/custom-id.ts';

const NODE = '0190f3a2-7b1c-7d3e-8f00-00000000abcd';

describe('topic custom_id', () => {
  it('encodes within the API alphabet and length limit', () => {
    for (const kind of ['concepts', 'tldr', 'study', 'deep', 'glossary', 'cards', 'questions', 'feed'] as const) {
      const id = buildTopicCustomId(NODE, kind);
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it('round-trips node and kind, including the deep note (LRN-01.4)', () => {
    const id = buildTopicCustomId(NODE, 'cards');
    expect(parseTopicCustomId(id)).toEqual({ nodeId: NODE, kind: 'cards' });
    expect(parseTopicCustomId(buildTopicCustomId(NODE, 'deep'))).toEqual({ nodeId: NODE, kind: 'deep' });
    expect(expandKinds(['deep'])).toEqual(['deep']);
  });

  it('rejects non-UUID node ids and unknown codes', () => {
    expect(() => buildTopicCustomId('topic-1', 'cards')).toThrow(/UUID/);
    expect(parseTopicCustomId('0190f3a27b1c7d3e8f00000000abcd-z')).toBeNull();
    expect(parseTopicCustomId('not-an-id')).toBeNull();
  });

  it('expands the public kinds of api.md §7', () => {
    expect(expandKinds(['notes', 'cards'])).toEqual(['tldr', 'study', 'cards']);
    expect(expandKinds(['concepts', 'concepts'])).toEqual(['concepts']);
    expect(expandKinds(['unknown'])).toEqual([]);
  });
});

describe('transcription custom_id', () => {
  it('round-trips page runs', () => {
    expect(buildPagesCustomId(12, 31)).toBe('p12-31');
    expect(parsePagesCustomId('p12-31')).toEqual({ start: 12, end: 31 });
    expect(parsePagesCustomId('p31-12')).toBeNull();
  });
});
