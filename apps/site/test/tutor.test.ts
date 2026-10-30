import { describe, expect, test } from 'vitest';
import { SUGGESTIONS, answer, normalize } from '../src/tutor.ts';

describe('the tutor on p. 4', () => {
  test('questions about the page are answered with the page they came from', () => {
    const cases: [string, number][] = [
      ['Funciona no iPhone?', 6],
      ['Dá pra estudar com a turma?', 6],
      ['E se eu errar uma questão?', 5],
      ['Como funciona o plano até a prova?', 3],
      ['Por que eu esqueço?', 1],
      ['O que vira o meu PDF?', 2],
    ];
    for (const [question, page] of cases) {
      const a = answer(question);
      expect(a.kind, question).toBe('grounded');
      if (a.kind === 'grounded') expect(a.cite.page, question).toBe(page);
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
