import { describe, expect, it } from 'vitest';
import { cardFrontKey, clozeAnswer, clozeIndexes, mapCard, mapGlossaryTerm, mapQuestion, toSourcePages, type LabelMap, type QuestionDraft } from '../../src/ingest/mappers.ts';

const DOC = '0190f3a2-7b1c-7d3e-8f00-00000000d0c1';
const CONCEPT_C1 = '0190f3a2-7b1c-7d3e-8f00-0000000000c1';
const CONCEPT_C2 = '0190f3a2-7b1c-7d3e-8f00-0000000000c2';
const TOPIC = '0190f3a2-7b1c-7d3e-8f00-0000000000a1';

const labels: LabelMap = { labels: { D1: DOC }, allowedPages: { D1: [1, 2, 3, 4, 5] } };
const concepts = new Map([
  ['c1', CONCEPT_C1],
  ['c2', CONCEPT_C2],
]);

describe('toSourcePages (TRU-01.2)', () => {
  it('converts labels to document ids and merges contiguous ranges', () => {
    expect(
      toSourcePages(
        [
          { doc: 'D1', page_start: 1, page_end: 2 },
          { doc: 'D1', page_start: 3, page_end: 3 },
        ],
        labels,
      ),
    ).toEqual([{ document_id: DOC, page_start: 1, page_end: 3 }]);
  });

  it('invalidates the whole item when any page was not sent', () => {
    expect(toSourcePages([{ doc: 'D1', page_start: 4, page_end: 9 }], labels)).toBeNull();
  });

  it('invalidates unknown labels and inverted ranges', () => {
    expect(toSourcePages([{ doc: 'D9', page_start: 1, page_end: 1 }], labels)).toBeNull();
    expect(toSourcePages([{ doc: 'D1', page_start: 3, page_end: 2 }], labels)).toBeNull();
  });
});

describe('mapQuestion (spec 05 §8.1)', () => {
  const options = ['A', 'B', 'C', 'D', 'E'].map((id, i) => ({
    id,
    text: `Alternativa ${id}`,
    rationale: `Motivo ${i}`,
    misconception_concept_key: id === 'B' ? 'c2' : null,
  }));
  const base: QuestionDraft = {
    type: 'mcq_single',
    stem: 'Qual organela produz ATP?',
    stimulus_md: '',
    explanation: 'A mitocôndria realiza a respiração celular.',
    bloom_level: 'remember',
    difficulty: 2,
    concept_keys: ['c1'],
    source_pages: [{ doc: 'D1', page_start: 1, page_end: 2 }],
    remediation_card: { front: 'Onde ocorre a respiração?', back: 'Na mitocôndria.' },
    payload: { options, correct: 'C' },
  };

  it('maps options with the misconception concept id and keeps the remediation card', () => {
    const mapped = mapQuestion(base, { labels, conceptIdByKey: concepts });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.payload).toMatchObject({ correct: 'C', remediation_card: base.remediation_card });
    const opts = mapped.value.payload.options as Array<Record<string, unknown>>;
    expect(opts[1]).toMatchObject({ id: 'B', misconception_concept_id: CONCEPT_C2 });
    expect(opts[0]).not.toHaveProperty('misconception_concept_id');
    expect(mapped.value.concept_ids).toEqual([CONCEPT_C1]);
    expect(mapped.value.source_pages).toEqual([{ document_id: DOC, page_start: 1, page_end: 2 }]);
  });

  it('accepts four or five multiple-choice options (spec 05 PRA-01.1)', () => {
    const four = { ...base, payload: { options: options.slice(0, 4), correct: 'A' } };
    expect(mapQuestion(four, { labels, conceptIdByKey: concepts }).ok).toBe(true);
    const three = { ...base, payload: { options: options.slice(0, 3), correct: 'A' } };
    expect(mapQuestion(three, { labels, conceptIdByKey: concepts })).toEqual({ ok: false, reason: 'mcq_options_count' });
  });

  it('drops questions whose concepts are not in the topic', () => {
    expect(mapQuestion({ ...base, concept_keys: ['c9'] }, { labels, conceptIdByKey: concepts })).toEqual({ ok: false, reason: 'concept_not_in_topic' });
  });

  it('stores matching pairs as tuples (spec 05 §8.1)', () => {
    const draft: QuestionDraft = {
      ...base,
      type: 'matching',
      payload: {
        left: [{ id: 'L1', text: 'a' }, { id: 'L2', text: 'b' }],
        right: [{ id: 'R1', text: 'x' }, { id: 'R2', text: 'y' }, { id: 'R3', text: 'z' }],
        pairs: [{ left: 'L1', right: 'R2' }, { left: 'L2', right: 'R1' }],
      },
    };
    const mapped = mapQuestion(draft, { labels, conceptIdByKey: concepts });
    expect(mapped.ok && mapped.value.payload.pairs).toEqual([['L1', 'R2'], ['L2', 'R1']]);
  });

  it('stimulus becomes a markdown object', () => {
    const mapped = mapQuestion({ ...base, stimulus_md: '| a | b |' }, { labels, conceptIdByKey: concepts });
    expect(mapped.ok && mapped.value.stimulus).toEqual({ markdown: '| a | b |' });
  });
});

describe('mapCard (spec 04 §5.1)', () => {
  const basic = { type: 'basic' as const, front: 'Qual organela produz ATP?', back: 'Mitocôndria', cloze_text: null, concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 1, page_end: 1 }], difficulty_estimate: 2 };

  it('maps a single card with origin fields left to the writer', () => {
    const mapped = mapCard(basic, { labels, conceptIdByKey: concepts });
    expect(mapped.ok && mapped.value).toEqual([
      expect.objectContaining({ type: 'basic', concept_id: CONCEPT_C1, cloze_index: null, sibling_key: null }),
    ]);
  });

  it('expands a cloze sentence with several deletions into sibling cards', () => {
    const cloze = { ...basic, type: 'cloze' as const, front: 'x', back: 'ATP', cloze_text: 'Produz {{c1::ATP}} na {{c2::respiração}}' };
    const mapped = mapCard(cloze, { labels, conceptIdByKey: concepts });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.map((r) => r.cloze_index)).toEqual([1, 2]);
    expect(mapped.value.every((r) => r.sibling_key === 1)).toBe(true);
    expect(mapped.value[0]?.front).toBe('Produz {{c1::ATP}} na {{c2::respiração}}');
    expect(mapped.value.map((r) => r.back)).toEqual(['ATP', 'respiração']);
  });

  it('reads each deletion answer without its hint', () => {
    expect(clozeAnswer('{{c1::Brasília::capital}} fica no {{c2::DF}}', 1)).toBe('Brasília');
    expect(clozeAnswer('{{c1::Brasília::capital}} fica no {{c2::DF}}', 2)).toBe('DF');
  });

  it('rejects a cloze without a deletion', () => {
    expect(mapCard({ ...basic, type: 'cloze', cloze_text: 'sem marcação' }, { labels, conceptIdByKey: concepts }).ok).toBe(false);
    expect(clozeIndexes('sem marcação')).toEqual([]);
  });

  it('normalizes fronts for duplicate checks, stripping cloze markers', () => {
    expect(cardFrontKey('Produz {{c1::ATP}}!')).toBe('produz atp');
  });
});

describe('mapGlossaryTerm (LRN-02)', () => {
  it('normalizes the term, drops aliases equal to it and attaches the concept', () => {
    const mapped = mapGlossaryTerm(
      { term: 'Mitocôndria', definition: 'Organela.', example: null, aliases: ['mitocondria', 'mitocôndrias'], concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 1, page_end: 1 }] },
      { labels, conceptIdByKey: concepts, topicId: TOPIC },
    );
    expect(mapped.ok && mapped.value).toMatchObject({ normalized_term: 'mitocondria', aliases: ['mitocôndrias'], node_id: CONCEPT_C1 });
  });

  it('falls back to the topic when the concept key is unknown', () => {
    const mapped = mapGlossaryTerm(
      { term: 'Lisossomo', definition: 'Organela.', example: null, aliases: [], concept_key: 'zz', source_pages: [{ doc: 'D1', page_start: 2, page_end: 2 }] },
      { labels, conceptIdByKey: concepts, topicId: TOPIC },
    );
    expect(mapped.ok && mapped.value.node_id).toBe(TOPIC);
  });
});
