import { describe, expect, it } from 'vitest';
import {
  damerauLevenshtein,
  foldAnswer,
  matchAcceptedAnswer,
  maxTypoDistance,
  parseDecimal,
  stripAccents,
} from '../../src/practice/index.ts';

describe('foldAnswer and stripAccents', () => {
  it('removes accents, lowercases, trims and collapses spaces', () => {
    expect(foldAnswer('  Mitocôndria   Celular ')).toBe('mitocondria celular');
    expect(foldAnswer('AÇÃO')).toBe('acao');
  });

  it('removes decomposed combining marks as well as precomposed letters', () => {
    expect(foldAnswer('mitocôndria')).toBe(foldAnswer('mitocôndria'));
  });

  it('keeps case in stripAccents', () => {
    expect(stripAccents('NÃO é')).toBe('NAO e');
  });
});

describe('damerauLevenshtein', () => {
  it('computes classic distances', () => {
    expect(damerauLevenshtein('', 'abc')).toBe(3);
    expect(damerauLevenshtein('abc', '')).toBe(3);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
  });

  it('counts an adjacent transposition as one edit (unrestricted Damerau)', () => {
    expect(damerauLevenshtein('ab', 'ba')).toBe(1);
    expect(damerauLevenshtein('mitocondira', 'mitocondria')).toBe(1);
    // Unrestricted Damerau: "ca" -> "abc" is 2 (OSA would give 3).
    expect(damerauLevenshtein('ca', 'abc')).toBe(2);
  });

  it('is symmetric on a sample of pairs', () => {
    const pairs: Array<[string, string]> = [
      ['mitose', 'meiose'],
      ['adenosina', 'adenozina'],
      ['ca', 'abc'],
    ];
    for (const [a, b] of pairs) expect(damerauLevenshtein(a, b)).toBe(damerauLevenshtein(b, a));
  });
});

describe('typo budget (PRA-01.7)', () => {
  it('allows distance 1 for length ≥ 5, distance 2 for length ≥ 10, and exact match below 5', () => {
    expect(maxTypoDistance('atp')).toBe(0);
    expect(maxTypoDistance('abcd')).toBe(0);
    expect(maxTypoDistance('abcde')).toBe(1);
    expect(maxTypoDistance('abcdefghi')).toBe(1);
    expect(maxTypoDistance('abcdefghij')).toBe(2);
  });
});

describe('matchAcceptedAnswer', () => {
  it('accepts "mitocondria" and "mitocôndira" for "mitocôndria" and rejects "mitose" (spec 05 §11)', () => {
    expect(matchAcceptedAnswer('mitocondria', ['mitocôndria'])).toEqual({ canonical: 'mitocôndria', typo: 'mitocôndria', distance: 0 });
    expect(matchAcceptedAnswer('mitocôndira', ['mitocôndria'])).toEqual({ canonical: 'mitocôndria', typo: 'mitocôndria', distance: 1 });
    expect(matchAcceptedAnswer('mitose', ['mitocôndria'])).toBeNull();
  });

  it('returns no typo when the typed text equals the accepted spelling', () => {
    expect(matchAcceptedAnswer('mitocôndria', ['mitocôndria'])).toEqual({ canonical: 'mitocôndria', typo: null, distance: 0 });
    expect(matchAcceptedAnswer('  mitocôndria ', ['mitocôndria'])?.typo).toBeNull();
  });

  it('accepts one deletion, insertion or substitution for length ≥ 5, and one transposition', () => {
    expect(matchAcceptedAnswer('mitocndria', ['mitocôndria'])?.distance).toBe(1);
    expect(matchAcceptedAnswer('mitocoondria', ['mitocôndria'])?.distance).toBe(1);
    expect(matchAcceptedAnswer('mitocandria', ['mitocôndria'])?.distance).toBe(1);
    expect(matchAcceptedAnswer('mitocodnria', ['mitocôndria'])?.distance).toBe(1);
  });

  it('allows two edits only for length ≥ 10', () => {
    expect(matchAcceptedAnswer('adenosna trfosfato', ['adenosina trifosfato'])?.distance).toBe(2);
    expect(matchAcceptedAnswer('elétron', ['elétrons'])?.distance).toBe(1);
    expect(matchAcceptedAnswer('eletrn', ['elétron'])?.distance).toBe(1);
    // Length 7 has a budget of 1, so two edits are rejected.
    expect(matchAcceptedAnswer('eltroa', ['elétron'])).toBeNull();
  });

  it('applies no typo budget to short answers (length < 5)', () => {
    expect(matchAcceptedAnswer('ATB', ['ATP'])).toBeNull();
    expect(matchAcceptedAnswer('atp', ['ATP'])).toEqual({ canonical: 'ATP', typo: 'ATP', distance: 0 });
  });

  it('returns null for empty input and ignores empty accepted entries', () => {
    expect(matchAcceptedAnswer('   ', ['ATP'])).toBeNull();
    expect(matchAcceptedAnswer('ATP', ['', '  '])).toBeNull();
  });

  it('prefers the closest accepted entry', () => {
    const match = matchAcceptedAnswer('adenosina trifosfato', ['adenosina trifostato', 'adenosina trifosfato']);
    expect(match).toEqual({ canonical: 'adenosina trifosfato', typo: null, distance: 0 });
  });
});

describe('parseDecimal', () => {
  it('reads PT-BR and EN decimals and rejects non-numbers', () => {
    expect(parseDecimal('9,8')).toBe(9.8);
    expect(parseDecimal(' 9.8 ')).toBe(9.8);
    expect(parseDecimal('-2e3')).toBe(-2000);
    expect(parseDecimal('1.000,5')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('')).toBeNull();
  });
});
