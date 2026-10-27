import { describe, expect, it } from 'vitest';
import {
  acronymOf,
  cycleLayout,
  encodesItems,
  findingStatus,
  flowchartLayout,
  hierarchyLayout,
  isMnemonicList,
  placeOnLoci,
  rankFindings,
  timelineOrder,
  visibleFindings,
  visualSpecErrors,
} from '../../src/learning/index.ts';
import { MnemonicSuggestReqSchema, VisualSpecSchema, PeerQuestionCreateReqSchema, ProfileSettingsSchema, QuizScopeSchema } from '../../src/core/index.ts';

describe('visual specs (LRN-05)', () => {
  const flow = {
    type: 'flowchart' as const,
    nodes: [
      { id: 'a', label: 'Glicose' },
      { id: 'b', label: 'Glicólise' },
      { id: 'c', label: 'Piruvato' },
      { id: 'd', label: 'Krebs' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'b' },
    ],
  };

  it('accepts a valid spec and lays a flowchart out in layers (back edges do not loop)', () => {
    expect(visualSpecErrors(flow)).toEqual([]);
    expect(flowchartLayout(flow).map((n) => [n.id, n.y])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
  });

  it('enforces the LRN-05.6 limits and structure', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    expect(visualSpecErrors({ type: 'cycle', nodes: many })).toEqual(['cycle_nodes']);
    expect(visualSpecErrors({ ...flow, edges: [{ from: 'a', to: 'z' }] })).toEqual(['edge_endpoints']);
    expect(visualSpecErrors({ type: 'comparison_table', columns: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], rows: [{ criterion: 'c', cells: ['1'] }] })).toEqual(['comparison_cells']);
    const deep = ['r', 'a', 'b', 'c', 'd'].map((id, i, arr) => ({ id, label: id, parent_id: i === 0 ? null : arr[i - 1]! }));
    expect(visualSpecErrors({ type: 'hierarchy', nodes: deep })).toEqual(['hierarchy_levels']);
    expect(visualSpecErrors({ type: 'hierarchy', nodes: [{ id: 'a', label: 'a', parent_id: 'b' }, { id: 'b', label: 'b', parent_id: 'a' }] })).toEqual(['hierarchy_root', 'hierarchy_structure']);
  });

  it('cycle starts at the top; hierarchy centers parents; timeline sorts', () => {
    const c = cycleLayout(4);
    expect(c[0]!.y).toBeCloseTo(-1);
    expect(c[1]!.x).toBeCloseTo(1);
    const h = hierarchyLayout({ type: 'hierarchy', nodes: [{ id: 'r', label: 'R', parent_id: null }, { id: 'a', label: 'A', parent_id: 'r' }, { id: 'b', label: 'B', parent_id: 'r' }] });
    expect(h).toEqual([{ id: 'r', x: 0.5, y: 0 }, { id: 'a', x: 0, y: 1 }, { id: 'b', x: 1, y: 1 }]);
    expect(timelineOrder([{ id: 'b', sort_key: 1822 }, { id: 'a', sort_key: 1500 }]).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('the Zod schema rejects oversized specs', () => {
    expect(VisualSpecSchema.safeParse(flow).success).toBe(true);
    expect(VisualSpecSchema.safeParse({ type: 'timeline', events: Array.from({ length: 16 }, (_, i) => ({ id: `${i}`, date_label: `${i}`, sort_key: i, title: 't' })) }).success).toBe(false);
  });
});

describe('mnemonics (MEM-06)', () => {
  const items = ['Prófase', 'Metáfase', 'Anáfase', 'Telófase'];

  it('acronyms and phrases must encode the list', () => {
    expect(acronymOf(items)).toBe('PMAT');
    expect(encodesItems('acronym', 'PMAT', items)).toBe(true);
    expect(encodesItems('acronym', 'MAPT', items)).toBe(false);
    expect(encodesItems('phrase', 'Pedro Mandou a Ana Tocar', items)).toBe(true);
    expect(encodesItems('phrase', 'Pedro Mandou Tocar', items)).toBe(false);
  });

  it('palace placement keeps the order and refuses overflow', () => {
    expect(placeOnLoci(items.slice(0, 2), ['portão', 'sala', 'cozinha'])).toEqual([{ locus: 'portão', item: 'Prófase' }, { locus: 'sala', item: 'Metáfase' }]);
    expect(() => placeOnLoci(items, ['portão'])).toThrow();
    expect(isMnemonicList(items)).toBe(true);
    expect(isMnemonicList(items.slice(0, 2))).toBe(false);
  });

  it('a palace request needs a palace; a request needs a card or a concept', () => {
    expect(MnemonicSuggestReqSchema.safeParse({ type: 'palace', card_id: '0190f0f0-0000-7000-8000-000000000001' }).success).toBe(false);
    expect(MnemonicSuggestReqSchema.safeParse({ type: 'any' }).success).toBe(false);
    expect(MnemonicSuggestReqSchema.parse({ node_id: '0190f0f0-0000-7000-8000-000000000001' }).type).toBe('any');
  });
});

describe('material findings (ING-06)', () => {
  it('mirrors the SQL vote rule', () => {
    expect(findingStatus({ shared: false, confirmations: 0, dismissals: 1, lastVote: 'not_error' })).toBe('dismissed');
    expect(findingStatus({ shared: true, confirmations: 1, dismissals: 0, lastVote: 'is_error' })).toBe('open');
    expect(findingStatus({ shared: true, confirmations: 2, dismissals: 3, lastVote: 'not_error' })).toBe('confirmed');
    expect(findingStatus({ shared: true, confirmations: 1, dismissals: 2, lastVote: 'not_error' })).toBe('dismissed');
  });

  it('orders by severity, caps at 20, hides low and my dismissals', () => {
    const f = (id: string, severity: 'low' | 'medium' | 'high', page: number) => ({ id, severity, page_start: page, description: id, status: 'open' as const });
    const many = Array.from({ length: 25 }, (_, i) => f(`m${i}`, 'medium', i + 1));
    expect(rankFindings([f('l', 'low', 1), ...many, f('h', 'high', 30)])[0]!.id).toBe('h');
    expect(rankFindings(many)).toHaveLength(20);
    const shown = visibleFindings([f('l', 'low', 1), f('h', 'high', 2), f('m', 'medium', 3)], { showLow: false, myVotes: new Map([['m', 'not_error']]) });
    expect(shown.map((x) => x.id)).toEqual(['h']);
  });
});

describe('Phase 5 request schemas', () => {
  it('peer questions default to a real submission, not anonymous', () => {
    const r = PeerQuestionCreateReqSchema.parse({
      subject_id: '0190f0f0-0000-7000-8000-000000000001',
      node_id: '0190f0f0-0000-7000-8000-000000000002',
      type: 'true_false',
      stem: 'A mitose gera duas células iguais?',
      payload: { statement: 'x', correct: true },
    });
    expect(r).toMatchObject({ dry_run: false, anonymous: false });
  });

  it('semester ends are MM-DD; a boss scope names its unit', () => {
    expect(ProfileSettingsSchema.safeParse({ semester_ends: ['06-30', '11-30'] }).success).toBe(true);
    expect(ProfileSettingsSchema.safeParse({ semester_ends: ['2026-06-30'] }).success).toBe(false);
    expect(QuizScopeSchema.parse({ unit_node_id: '0190f0f0-0000-7000-8000-000000000001' }).unit_node_id).toBeDefined();
  });
});
