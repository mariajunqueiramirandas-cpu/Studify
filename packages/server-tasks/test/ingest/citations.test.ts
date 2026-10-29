import { describe, expect, it } from 'vitest';
import { markerIndexes, renderCitedBody, type CitationInput } from '../../src/ingest/citations.ts';

const DOC = '0190f3a2-7b1c-7d3e-8f00-000000000001';

function cite(partial: Partial<CitationInput> & Pick<CitationInput, 'textStart' | 'textEnd'>): CitationInput {
  return { documentId: DOC, pageStart: 3, pageEnd: 4, citedText: 'trecho', valid: true, ...partial };
}

describe('renderCitedBody', () => {
  it('inserts a marker right after the cited block and keeps the stored index', () => {
    const text = 'A mitocôndria produz ATP. Ela fica no citoplasma.';
    const first = text.indexOf('. Ela') + 1; // end of the first sentence
    const out = renderCitedBody(text, [cite({ textStart: 0, textEnd: first, citedText: 'mitocôndria produz ATP' })]);
    expect(out.body).toBe('A mitocôndria produz ATP.[[cite:0]] Ela fica no citoplasma.');
    expect(out.citations).toEqual([
      { start: 0, end: first, document_id: DOC, page_start: 3, page_end: 4, cited_text: 'mitocôndria produz ATP' },
    ]);
    expect(out.dropped).toBe(0);
  });

  it('shifts stored offsets past earlier markers', () => {
    const text = 'Um. Dois. Três.';
    const out = renderCitedBody(text, [
      cite({ textStart: 0, textEnd: 3, citedText: 'a' }),
      cite({ textStart: 4, textEnd: 9, citedText: 'b', pageStart: 5, pageEnd: 5 }),
    ]);
    expect(out.body).toBe('Um.[[cite:0]] Dois.[[cite:1]] Três.');
    expect(out.citations[1]).toMatchObject({ start: 4 + '[[cite:0]]'.length, end: 9 + '[[cite:0]]'.length, cited_text: 'b' });
    // Every stored start/end points at the cited text in the final body.
    for (const c of out.citations) {
      expect(out.body.slice(c.start, c.end).replace(/\[\[cite:\d+\]\]/g, '')).toMatch(/\S/);
    }
    expect(markerIndexes(out.body)).toEqual([0, 1]);
  });

  it('drops invalid citations and counts them', () => {
    const out = renderCitedBody('Texto.', [
      cite({ textStart: 0, textEnd: 6, valid: false }),
      cite({ textStart: 0, textEnd: 6, pageStart: null, pageEnd: null }),
      cite({ textStart: 0, textEnd: 600 }),
    ]);
    expect(out.citations).toHaveLength(0);
    expect(out.body).toBe('Texto.');
    expect(out.dropped).toBe(3);
  });

  it('deduplicates identical citations so each chip appears once', () => {
    const out = renderCitedBody('Frase.', [cite({ textStart: 0, textEnd: 6 }), cite({ textStart: 0, textEnd: 6 })]);
    expect(out.citations).toHaveLength(1);
    expect(markerIndexes(out.body)).toEqual([0]);
  });

  it('keeps several markers at the same offset in citation order', () => {
    const out = renderCitedBody('Frase.', [
      cite({ textStart: 0, textEnd: 6, citedText: 'x', pageStart: 1, pageEnd: 1 }),
      cite({ textStart: 0, textEnd: 6, citedText: 'y', pageStart: 2, pageEnd: 2 }),
    ]);
    expect(out.body).toBe('Frase.[[cite:0]][[cite:1]]');
  });
});
