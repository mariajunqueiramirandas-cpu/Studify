import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  MAX_WRITTEN_TOPICS,
  TOPICS_PER_CALL,
  apostilaDocumentId,
  apostilaOutline,
  buildApostilaPdf,
  capListedUnits,
  drawableText,
  isApostila,
  wrapLines,
  writeChunks,
  type WrittenSection,
} from '../../src/ingest/apostila.ts';
import { extractPages } from '../../src/ingest/pdf-text.ts';
import { preflightPdf } from '../../src/ingest/pdf-preflight.ts';
import type { OutlineOut, OutlineUnitOut } from '../../src/ingest/outline-normalize.ts';

function unit(key: string, topicCount: number): OutlineUnitOut {
  return {
    key,
    title: `Unidade ${key}`,
    summary: 'Resumo da unidade.',
    page_start: 1,
    page_end: 1,
    match_existing_node_id: null,
    topics: Array.from({ length: topicCount }, (_v, i) => ({
      key: `${key}t${i + 1}`,
      title: `Tópico ${key}.${i + 1}`,
      summary: 'Resumo do tópico.',
      learning_objectives: ['Explicar o tópico.'],
      page_start: 1,
      page_end: 1,
      match_existing_node_id: null,
    })),
  };
}

const longSections = (n: number): WrittenSection[] =>
  Array.from({ length: n }, (_v, i) => ({
    heading: `Seção ${i + 1}`,
    paragraphs: [
      'A respiração celular libera a energia guardada na glicose e a armazena em ATP. '.repeat(12),
      '- A glicólise acontece no citoplasma.',
    ],
  }));

describe('apostila ids', () => {
  it('derives a stable UUID from the list id', () => {
    const list = '0192f3a4-1111-7000-8000-000000000001';
    const id = apostilaDocumentId(list);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(apostilaDocumentId(list)).toBe(id);
    expect(apostilaDocumentId('0192f3a4-1111-7000-8000-000000000002')).not.toBe(id);
  });
});

describe('listed topics', () => {
  it('cuts the list at MAX_WRITTEN_TOPICS, in list order', () => {
    const units = [unit('a', 40), unit('b', 30), unit('c', 5)];
    const capped = capListedUnits(units);
    expect(capped.map((u) => u.topics.length)).toEqual([40, MAX_WRITTEN_TOPICS - 40]);
  });

  it('writes a unit in calls of at most TOPICS_PER_CALL topics', () => {
    const chunks = writeChunks([unit('a', TOPICS_PER_CALL + 2), unit('b', 1)]);
    expect(chunks).toEqual([
      { unitIndex: 0, topicIndexes: Array.from({ length: TOPICS_PER_CALL }, (_v, i) => i) },
      { unitIndex: 0, topicIndexes: [TOPICS_PER_CALL, TOPICS_PER_CALL + 1] },
      { unitIndex: 1, topicIndexes: [0] },
    ]);
  });
});

describe('text for the standard fonts', () => {
  it('keeps Portuguese accents and writes out symbols the font lacks', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(drawableText('Função: ação e reação — “ok”', font)).toBe('Função: ação e reação — “ok”');
    expect(drawableText('Δx ≤ 2π e H₂O', font)).toBe('Delta x <= 2pi e H2O');
    expect(drawableText('漢', font)).toBe('?');
    expect(() => font.encodeText(drawableText('√2 ≈ 1,41 → ∞ αβ', font))).not.toThrow();
  });

  it('wraps to the width and cuts words wider than a line', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapLines(`curta ${'x'.repeat(200)} fim`, font, 11, 120);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(120);
    expect(lines.join('')).toContain('fim');
  });
});

describe('buildApostilaPdf', () => {
  it('starts every topic on its own page and reports the pages of each unit and topic', async () => {
    const pdf = await buildApostilaPdf({
      subjectName: 'Biologia',
      listTitle: 'Sumário 2º bimestre',
      units: [
        { title: 'Células', topics: [{ title: 'Respiração celular', sections: longSections(6) }, { title: 'Fotossíntese', sections: longSections(1) }] },
        { title: 'Genética', topics: [{ title: 'Leis de Mendel', sections: longSections(2) }] },
      ],
    });
    const [u1, u2] = pdf.units;
    expect(u1!.topics[0]!.start).toBe(2);
    expect(u1!.topics[0]!.end).toBeGreaterThan(2);
    expect(u1!.topics[1]!.start).toBe(u1!.topics[0]!.end + 1);
    expect(u1).toMatchObject({ start: 2, end: u1!.topics[1]!.end });
    expect(u2!.start).toBe(u1!.end + 1);
    expect(u2!.end).toBe(pdf.pageCount);

    // The text layer is real text (citations highlight it), and the PDF is marked as an apostila.
    const pages = await extractPages(pdf.bytes);
    expect(pages).toHaveLength(pdf.pageCount);
    expect(pages[0]!.text).toContain('Apostila Studify');
    expect(pages[u2!.start - 1]!.text).toContain('Leis de Mendel');
    expect(pages.every((p) => !p.scanned)).toBe(true);
    expect(isApostila(await PDFDocument.load(pdf.bytes))).toBe(true);
    const pre = await preflightPdf(pdf.bytes);
    expect(pre).toMatchObject({ ok: true, pageCount: pdf.pageCount, apostila: true });
  });

  it('places the list outline on the apostila pages', async () => {
    const units = [unit('a', 2)];
    const outline: OutlineOut = { is_study_material: true, language: 'pt-BR', detected_kind: 'content_list', lists_only: true, title_suggestion: 'Sumário', units };
    const pdf = await buildApostilaPdf({
      subjectName: 'Biologia',
      listTitle: 'Sumário',
      units: [{ title: units[0]!.title, topics: units[0]!.topics.map((t) => ({ title: t.title, sections: longSections(1) })) }],
    });
    const placed = apostilaOutline(outline, units, pdf);
    expect(placed).toMatchObject({ detected_kind: 'notes', lists_only: false });
    expect(placed.units[0]).toMatchObject({ page_start: 2, page_end: 3 });
    expect(placed.units[0]!.topics.map((t) => [t.page_start, t.page_end])).toEqual([[2, 2], [3, 3]]);
  });
});
