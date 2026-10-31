import { describe, expect, test } from 'vitest';
import { SUGGESTIONS, answer, normalize, type SectionId } from '../src/tutor.ts';

describe('the tutor demo', () => {
  test('questions about the page are answered with the section they came from', () => {
    const cases: [string, SectionId][] = [
      ['Funciona no iPhone?', 'baixar'],
      ['Dá pra estudar com a turma?', 'turma'],
      ['E se eu errar uma questão?', 'recursos'],
      ['Como funciona o plano até a prova?', 'plano'],
      ['Por que eu esqueço?', 'cartoes'],
      ['O que vira o meu PDF?', 'como-funciona'],
      ['Tem ENEM?', 'recursos'],
      ['Funciona offline?', 'recursos'],
    ];
    for (const [question, section] of cases) {
      const a = answer(question);
      expect(a.kind, question).toBe('grounded');
      if (a.kind === 'grounded') expect(a.cite.section, question).toBe(section);
    }
  });

  test('what the page does not say is "not in the material", including the price', () => {
    expect(answer('Quanto custa?').kind).toBe('missing');
    expect(answer('Quem descobriu o Brasil?').kind).toBe('missing');
    expect(answer('').kind).toBe('missing');
  });

  test('a general-knowledge question offers a clearly labelled answer', () => {
    const a = answer('Qual a capital da Mongólia?');
    expect(a.kind).toBe('missing');
    if (a.kind === 'missing') expect(a.general).toBe('Ulan Bator.');
  });

  test('every suggestion has an answer and matching ignores accents and case', () => {
    for (const s of SUGGESTIONS) expect(answer(s).text.length).toBeGreaterThan(0);
    expect(normalize('  Dá PRA estudar?! ')).toBe('da pra estudar');
    expect(answer('MEMÓRIA').kind).toBe('grounded');
  });
});
