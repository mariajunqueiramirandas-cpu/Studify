import { describe, expect, it } from 'vitest';
import { normalizeOutline, overlapViolations, type OutlineOut } from '../../src/ingest/outline-normalize.ts';

const RAW: OutlineOut = {
  is_study_material: true,
  language: 'pt-BR',
  detected_kind: 'slides',
  title_suggestion: 'Biologia',
  units: [
    {
      key: 'u1',
      title: 'Célula',
      summary: 'A célula e suas partes.',
      page_start: 1,
      page_end: 12,
      match_existing_node_id: 'known-unit',
      topics: [
        { key: 't1', title: 'Organelas', summary: 'Organelas.', learning_objectives: ['Identificar organelas'], page_start: 1, page_end: 6, match_existing_node_id: 'known-topic' },
        { key: 't2', title: 'Membrana', summary: 'Membrana.', learning_objectives: ['Explicar a membrana'], page_start: 6, page_end: 99, match_existing_node_id: 'ghost-id' },
      ],
    },
    { key: 'u2', title: 'Fora', summary: 'x', page_start: 50, page_end: 60, match_existing_node_id: null, topics: [] },
  ],
};

describe('normalizeOutline', () => {
  it('clamps page ranges to the document and drops units entirely outside it', () => {
    const out = normalizeOutline(RAW, { pageCount: 12, existingUnitIds: new Set(['known-unit']), existingTopicIds: new Set(['known-topic']), existingTopicCount: 0 });
    expect(out.units).toHaveLength(1);
    const topics = out.units[0]!.topics;
    expect(topics[1]).toMatchObject({ pageStart: 6, pageEnd: 12 });
    expect(out.warnings).toEqual([]);
  });

  it('keeps matches only when they reference a known node', () => {
    const out = normalizeOutline(RAW, { pageCount: 12, existingUnitIds: new Set(['known-unit']), existingTopicIds: new Set(['known-topic']), existingTopicCount: 0 });
    expect(out.units[0]?.matchId).toBe('known-unit');
    expect(out.units[0]?.topics[0]?.matchId).toBe('known-topic');
    expect(out.units[0]?.topics[1]?.matchId).toBeNull();
  });

  it('returns an empty map for non-study material', () => {
    const out = normalizeOutline({ ...RAW, is_study_material: false }, { pageCount: 12, existingUnitIds: new Set(), existingTopicIds: new Set(), existingTopicCount: 0 });
    expect(out.isStudyMaterial).toBe(false);
    expect(out.units).toEqual([]);
  });

  it('truncates topics beyond the subject limit with a warning', () => {
    const out = normalizeOutline(RAW, { pageCount: 12, existingUnitIds: new Set(), existingTopicIds: new Set(), existingTopicCount: 300 });
    const created = out.units.flatMap((u) => u.topics).filter((t) => t.matchId === null);
    expect(created).toHaveLength(0);
    expect(out.warnings.some((w) => w.includes('300 tópicos'))).toBe(true);
  });

  it('counts overlaps of more than one page', () => {
    const out = normalizeOutline(RAW, { pageCount: 12, existingUnitIds: new Set(['known-unit']), existingTopicIds: new Set(['known-topic']), existingTopicCount: 0 });
    expect(overlapViolations(out.units)).toBe(0);
  });
});
