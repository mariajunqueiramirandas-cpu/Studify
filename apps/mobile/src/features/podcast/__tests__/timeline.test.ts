import { episodeSources, flattenTimeline, lineAt, thinkCountdown } from '../timeline';

const script = {
  segments: [
    { id: 'seg1', kind: 'hook' as const, node_ids: [], title: 'Oi', lines: [{ speaker: 'bia' as const, text: 'Oi!' }], source_pages: [] },
    {
      id: 'seg2',
      kind: 'topic' as const,
      node_ids: [],
      title: 'Clorofila',
      lines: [
        { speaker: 'caio' as const, text: 'O que capta a luz?', pause_after_ms: 5000 },
        { speaker: 'bia' as const, text: 'A clorofila.' },
      ],
      source_pages: [
        { document_id: 'd1', page_start: 3, page_end: 3 },
        { document_id: 'd1', page_start: 3, page_end: 3 },
      ],
    },
  ],
};

const timings = [
  { segment_id: 'seg1', line_index: 0, start_ms: 0, end_ms: 1000 },
  { segment_id: 'seg2', line_index: 0, start_ms: 1000, end_ms: 8000 },
  { segment_id: 'seg2', line_index: 1, start_ms: 8000, end_ms: 9500 },
];

describe('podcast timeline (INT-01.7, INT-01.12)', () => {
  it('flattens lines with stored timings and finds the line playing', () => {
    const lines = flattenTimeline(script, timings);
    expect(lines.map((l) => [l.segmentId, l.startMs, l.endMs])).toEqual([
      ['seg1', 0, 1000],
      ['seg2', 1000, 8000],
      ['seg2', 8000, 9500],
    ]);
    expect(lineAt(lines, 0)).toBe(0);
    expect(lineAt(lines, 7999)).toBe(1);
    expect(lineAt(lines, 9000)).toBe(2);
  });

  it('counts down only inside a recall pause', () => {
    const lines = flattenTimeline(script, timings);
    expect(thinkCountdown(lines, 2500)).toBeNull(); // still speaking (pause starts at 3000)
    expect(thinkCountdown(lines, 3000)).toBe(5);
    expect(thinkCountdown(lines, 7600)).toBe(1);
    expect(thinkCountdown(lines, 8000)).toBeNull();
  });

  it('estimates timings when none are stored, and lists each source once', () => {
    const lines = flattenTimeline(script, null);
    expect(lines[1]!.startMs).toBe(lines[0]!.endMs);
    expect(lines[2]!.startMs).toBeGreaterThan(lines[1]!.startMs);
    expect(episodeSources(script)).toEqual([{ document_id: 'd1', page_start: 3, page_end: 3 }]);
  });
});
