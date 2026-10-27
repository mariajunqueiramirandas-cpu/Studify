import { appendTranscript, speechChunks } from '../speech-text';

describe('speechChunks (WEL-04.8)', () => {
  it('drops citation markers and cloze braces and speaks formulas in words', () => {
    const chunks = speechChunks('A área é $x^2$.[[cite:1]] O {{c1::cloroplasto}} faz fotossíntese.');
    expect(chunks.join(' ')).not.toMatch(/cite|\{\{|\$/);
    expect(chunks.join(' ')).toContain('cloroplasto');
    expect(chunks.join(' ')).toContain('ao quadrado');
  });

  it('keeps every utterance under the engine limit without losing words', () => {
    const sentence = 'A mitocôndria produz energia para a célula. ';
    const text = sentence.repeat(200);
    const chunks = speechChunks(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join(' ').split('mitocôndria').length - 1).toBe(200);
  });
});

describe('appendTranscript (WEL-04.9)', () => {
  it('capitalizes a first utterance and appends later ones', () => {
    expect(appendTranscript('', 'o que é osmose')).toBe('O que é osmose');
    expect(appendTranscript('O que é osmose', 'e difusão?')).toBe('O que é osmose e difusão?');
    expect(appendTranscript('abc', '   ')).toBe('abc');
  });
});
