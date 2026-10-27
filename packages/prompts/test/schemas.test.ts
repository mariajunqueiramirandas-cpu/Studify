import { describe, expect, it } from 'vitest';
import { SCHEMA_CASES } from './schema-cases.ts';
import { decodeQuestion, type QuestionType } from '../src/schemas/questions.ts';
import { decodeVisual } from '../src/schemas/phase5.ts';

describe('Zod output schemas: each has a valid and an invalid example', () => {
  it('covers every schema family used by the task catalog', () => {
    expect(SCHEMA_CASES.length).toBeGreaterThanOrEqual(45);
  });

  for (const testCase of SCHEMA_CASES) {
    it(`${testCase.name}: accepts the valid example`, () => {
      const result = testCase.schema.safeParse(testCase.valid);
      expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
    });
    it(`${testCase.name}: rejects the invalid example`, () => {
      expect(testCase.schema.safeParse(testCase.invalid).success).toBe(false);
    });
  }
});

describe('decodeQuestion', () => {
  const draft = (type: QuestionType, payload: unknown) => ({
    type,
    stem: 'Qual organela faz a fotossíntese?',
    stimulus_md: '',
    explanation: 'O cloroplasto tem clorofila.',
    bloom_level: 'remember' as const,
    difficulty: 2,
    concept_keys: ['c1'],
    source_pages: [{ doc: 'D1', page_start: 1, page_end: 1 }],
    remediation_card: { front: 'Onde ocorre a fotossíntese?', back: 'No cloroplasto.' },
    payload_json: JSON.stringify(payload),
  });
  const options = ['A', 'B', 'C', 'D'].map((id) => ({ id, text: `opção ${id}`, rationale: 'motivo' }));

  it('parses the payload and fills omitted nullable keys', () => {
    const decoded = decodeQuestion(draft('mcq_single', { options, correct: 'A' }));
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.question.type === 'mcq_single') {
      expect(decoded.question.payload.options[0]?.misconception_concept_key).toBeNull();
    }
  });

  it('turns numeric strings into numbers where the schema wants a number', () => {
    const decoded = decodeQuestion(draft('fill_blank', { text: 'A {{1}} faz fotossíntese.', blanks: [{ id: '1', accepted: ['planta'] }] }));
    expect(decoded.ok).toBe(true);
  });

  it('drops a payload that is not JSON or does not match the type', () => {
    expect(decodeQuestion({ ...draft('true_false', {}), payload_json: '{nope' })).toEqual({ ok: false, reason: 'payload_not_json' });
    expect(decodeQuestion(draft('true_false', { options, correct: 'A' }))).toEqual({ ok: false, reason: 'payload_invalid' });
    expect(decodeQuestion(draft('mcq_single', { options, correct: 'E' }))).toEqual({ ok: false, reason: 'payload_invalid' });
  });
});

describe('decodeVisual', () => {
  const base = { fits: true, reason: null, title: 'Fotossíntese', alt_text: 'A luz vira energia química no cloroplasto, em duas fases.', nodes: [], edges: [], events: [], columns: [], rows: [] };
  const node = (id: string, parent_id: string | null = null) => ({ id, label: `Nó ${id}`, detail: null, source: null, parent_id });

  it('rebuilds the typed visual from the lists of its type', () => {
    const flow = decodeVisual({ ...base, type: 'flowchart', nodes: [node('n1'), node('n2')], edges: [{ from: 'n1', to: 'n2', label: null }] });
    expect(flow?.visual).toMatchObject({ type: 'flowchart', nodes: [{ id: 'n1' }, { id: 'n2' }] });
    expect(flow?.visual && 'nodes' in flow.visual ? flow.visual.nodes[0] : null).not.toHaveProperty('parent_id');
    const tree = decodeVisual({ ...base, type: 'hierarchy', nodes: [node('n1'), node('n2', 'n1')] });
    expect(tree?.visual).toMatchObject({ type: 'hierarchy', nodes: [{ parent_id: null }, { parent_id: 'n1' }] });
  });

  it('maps "no fit" to visual null and refuses a visual that breaks its type', () => {
    expect(decodeVisual({ ...base, fits: false, type: 'none', title: '', alt_text: '', reason: 'Não fica bom.' })).toEqual({ fits: false, reason: 'Não fica bom.', visual: null });
    expect(decodeVisual({ ...base, type: 'flowchart', nodes: [node('n1')] })).toBeNull();
  });
});
