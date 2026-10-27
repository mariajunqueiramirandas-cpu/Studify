// Card shape rules (spec 04 §8.1–8.2): cloze cards keep their markers in cloze_text and the answer is the text
// of one marker; basic and reverse cards must not show the answer in the front.
import { describe, expect, it } from 'vitest';
import { CardDraft, SelectionCard, TutorCard, clozeAnswers } from '../src/schemas/cards.ts';

const ref = { doc: 'D1', page_start: 3, page_end: 3 };
const base = { type: 'basic', front: 'O que é ATP?', back: 'Molécula de energia.', cloze_text: null, concept_key: 'c1', source_pages: [ref], difficulty_estimate: 2 };
const cloze = (over: Record<string, unknown>) => ({ ...base, type: 'cloze', front: 'Frase sem marcas.', back: 'ATP', cloze_text: 'A mitocôndria produz {{c1::ATP}}.', ...over });

describe('clozeAnswers', () => {
  it('returns the answer of each marker and ignores the hint', () => {
    expect(clozeAnswers('Produz {{c1::ATP}} na {{c2::respiração::etapa final}}.')).toEqual(['ATP', 'respiração']);
    expect(clozeAnswers('sem marcação')).toEqual([]);
  });
});

describe('CardDraft cloze (MEM-01.2, spec 04 §8.2)', () => {
  it('accepts a cloze whose answer is the text of its marker, even though the sentence also contains it', () => {
    expect(CardDraft.safeParse(cloze({})).success).toBe(true);
    expect(CardDraft.safeParse(cloze({ front: 'Glicólise ocorre no citoplasma.', back: 'Glicólise', cloze_text: '{{c1::Glicólise}} ocorre no citoplasma.' })).success).toBe(true);
  });

  it('accepts a marker with a hint and matches the answer case-insensitively', () => {
    expect(CardDraft.safeParse(cloze({ back: 'atp', cloze_text: 'A mitocôndria produz {{c1::ATP::energia}}.' })).success).toBe(true);
  });

  it('accepts one to three markers (sibling cards are split later)', () => {
    expect(CardDraft.safeParse(cloze({ cloze_text: 'Produz {{c1::ATP}} e {{c2::NADH}}.' })).success).toBe(true);
    expect(CardDraft.safeParse(cloze({ cloze_text: 'A {{c1::a}} {{c2::b}} {{c3::c}} {{c4::d}}.', back: 'a' })).success).toBe(false);
  });

  it('rejects a cloze without a marker', () => {
    expect(CardDraft.safeParse(cloze({ cloze_text: 'A mitocôndria produz ATP.' })).success).toBe(false);
    expect(CardDraft.safeParse(cloze({ cloze_text: null })).success).toBe(false);
  });

  it('rejects a cloze whose answer is not inside a marker', () => {
    expect(CardDraft.safeParse(cloze({ back: 'Krebs', cloze_text: 'A mitocôndria produz {{c1::ATP}}.' })).success).toBe(false);
    expect(CardDraft.safeParse(cloze({ back: 'mitocôndria', cloze_text: 'A {{c1::mitocôndria}} produz ATP.' })).success).toBe(true);
  });

  it('TutorCard and SelectionCard apply the same cloze rule', () => {
    const tutor = { type: 'cloze', front: 'Frase com termo.', back: 'termo', cloze_text: 'Frase com {{c1::termo}}.' };
    expect(TutorCard.safeParse(tutor).success).toBe(true);
    expect(TutorCard.safeParse({ ...tutor, cloze_text: 'Frase com termo.' }).success).toBe(false);
    const selection = { type: 'cloze', front: 'x', back: 'Mitocôndria', cloze_text: '{{c1::Mitocôndria}} produz energia', concept_key: null };
    expect(SelectionCard.safeParse(selection).success).toBe(true);
  });
});

describe('CardDraft basic and reverse (spec 04 §8.2: answer not verbatim in the front)', () => {
  it('accepts a basic card with a plain question', () => {
    expect(CardDraft.safeParse(base).success).toBe(true);
    expect(CardDraft.safeParse({ ...base, type: 'reverse' }).success).toBe(true);
  });

  it('rejects a basic card whose answer appears in the front', () => {
    expect(CardDraft.safeParse({ ...base, front: 'Qual é a molécula de energia?', back: 'Molécula de energia' }).success).toBe(false);
  });

  it('rejects cloze_text on a basic card', () => {
    expect(CardDraft.safeParse({ ...base, cloze_text: 'sem marcação' }).success).toBe(false);
  });
});
