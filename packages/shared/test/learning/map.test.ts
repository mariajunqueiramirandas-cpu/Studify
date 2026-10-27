import { describe, expect, it } from 'vitest';
import {
  BAND_LABEL_PT,
  conceptRetrievability,
  glowOpacity,
  prerequisiteNudge,
  retrievabilityBand,
  topicRetrievability,
  type DetectiveNode,
} from '../../src/learning/index.ts';

describe('Mapa da Memória bands and glow (§16.1, MEM-05.2)', () => {
  it('band boundaries: Forte ≥ 0.90, Ok ≥ 0.75, Apagando ≥ 0.50, otherwise Quase esquecido', () => {
    expect(retrievabilityBand(0.9)).toBe('forte');
    expect(retrievabilityBand(0.89)).toBe('ok');
    expect(retrievabilityBand(0.75)).toBe('ok');
    expect(retrievabilityBand(0.74)).toBe('apagando');
    expect(retrievabilityBand(0.5)).toBe('apagando');
    expect(retrievabilityBand(0.49)).toBe('quase_esquecido');
    expect(retrievabilityBand(null)).toBe('nao_estudado');
    expect(BAND_LABEL_PT.nao_estudado).toBe('Ainda não estudado');
  });

  it('glow maps R onto 20–100%, and unstudied concepts have no glow', () => {
    expect(glowOpacity(1)).toBeCloseTo(1, 12);
    expect(glowOpacity(0)).toBeCloseTo(0.2, 12);
    expect(glowOpacity(null)).toBe(0);
  });

  it('concept value comes from cards, else from questions with at least 3 events', () => {
    expect(conceptRetrievability({ cardRetrievabilities: [0.8, 0.6], questionRetrievability: 0.9, questionEvidenceCount: 5 })).toEqual({ value: 0.7, source: 'cards' });
    expect(conceptRetrievability({ cardRetrievabilities: [], questionRetrievability: 0.9, questionEvidenceCount: 3 })).toEqual({ value: 0.9, source: 'questions' });
    expect(conceptRetrievability({ cardRetrievabilities: [], questionRetrievability: 0.9, questionEvidenceCount: 2 })).toEqual({ value: null, source: null });
  });

  it('topic value is weighted by card count and ignores concepts without data', () => {
    expect(topicRetrievability([{ value: 0.9, cardCount: 1 }, { value: 0.6, cardCount: 3 }, { value: null, cardCount: 5 }])).toBeCloseTo(0.675, 12);
    expect(topicRetrievability([{ value: null, cardCount: 2 }])).toBeNull();
  });
});

describe('prerequisite detective (§16.3, LRN-04)', () => {
  const node = (over: Partial<DetectiveNode> & { id: string }): DetectiveNode => ({
    mastery: 0.5,
    retrievability: 0.9,
    evidenceCount: 5,
    excluded: false,
    prerequisiteIds: [],
    ...over,
  });

  it('nudges the weakest prerequisite of a struggling node', () => {
    const nodes = new Map<string, DetectiveNode>([
      ['n', node({ id: 'n', mastery: 0.3, prerequisiteIds: ['a', 'b'] })],
      ['a', node({ id: 'a', mastery: 0.4 })],
      ['b', node({ id: 'b', mastery: 0.2 })],
    ]);
    expect(prerequisiteNudge(nodes.get('n')!, nodes)).toBe('b');
  });

  it('skips excluded prerequisites and needs at least five evidence events', () => {
    const nodes = new Map<string, DetectiveNode>([
      ['n', node({ id: 'n', mastery: 0.3, prerequisiteIds: ['x'] })],
      ['x', node({ id: 'x', mastery: 0.1, excluded: true })],
    ]);
    expect(prerequisiteNudge(nodes.get('n')!, nodes)).toBeNull();
    const few = new Map<string, DetectiveNode>([['n', node({ id: 'n', mastery: 0.3, evidenceCount: 4, prerequisiteIds: ['y'] })], ['y', node({ id: 'y', mastery: 0.1 })]]);
    expect(prerequisiteNudge(few.get('n')!, few)).toBeNull();
  });

  it('a prerequisite qualifies with low mastery or low retrievability', () => {
    const nodes = new Map<string, DetectiveNode>([
      ['n', node({ id: 'n', mastery: 0.3, prerequisiteIds: ['strong', 'forgotten'] })],
      ['strong', node({ id: 'strong', mastery: 0.9, retrievability: 0.95 })],
      ['forgotten', node({ id: 'forgotten', mastery: 0.9, retrievability: 0.5 })],
    ]);
    expect(prerequisiteNudge(nodes.get('n')!, nodes)).toBe('forgotten');
  });
});
