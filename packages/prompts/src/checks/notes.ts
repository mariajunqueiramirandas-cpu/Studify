// Mechanical checks after generation (spec 02 §8.1–8.2). These are not content verification.
import { studySections } from '../tasks/learn.ts';
import { countWords } from '../schemas/learn.ts';

export function headingsOf(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => (m[1] ?? '').replace(/[:.]$/, '').trim());
}

/** LRN-01.3 / §8.1: required H2 headings in order, and 400–900 words (±15%). */
export function checkStudyNote(markdown: string, hasFormulas: boolean): string[] {
  const issues: string[] = [];
  const headings = headingsOf(markdown);
  let cursor = 0;
  for (const expected of studySections(hasFormulas)) {
    const at = headings.indexOf(expected, cursor);
    if (at === -1) {
      issues.push(`seção ausente ou fora de ordem: ${expected}`);
    } else {
      cursor = at + 1;
    }
  }
  const words = countWords(markdown);
  if (words < 340 || words > 1035) issues.push(`contagem de palavras fora de 400–900 (±15%): ${words}`);
  return issues;
}

/** LRN-01.2: 5–8 bullets and at most 120 words. */
export function checkTldr(markdown: string): string[] {
  const issues: string[] = [];
  const bullets = markdown.split('\n').filter((line) => /^\s*[-*•]\s+/.test(line)).length;
  if (bullets < 5 || bullets > 8) issues.push(`Resumo rápido com ${bullets} bullets (esperado 5–8)`);
  const words = countWords(markdown);
  if (words > 120) issues.push(`Resumo rápido com ${words} palavras (máximo 120)`);
  return issues;
}

/** LRN-01.4: 1,200–2,500 words. */
export function checkDeepNote(markdown: string): string[] {
  const words = countWords(markdown);
  return words < 1200 || words > 2500 ? [`Aprofundado com ${words} palavras (esperado 1.200–2.500)`] : [];
}

export interface ParagraphCitations {
  text: string;
  citations: number;
}

/** §8.2: coverage = paragraphs with ≥ 1 citation / paragraphs with ≥ 12 words. */
export function citationCoverage(paragraphs: readonly ParagraphCitations[]): number {
  const eligible = paragraphs.filter((p) => countWords(p.text) >= 12);
  if (eligible.length === 0) return 1;
  return eligible.filter((p) => p.citations >= 1).length / eligible.length;
}

/** §8.2 threshold: below 0.6 → retry once, then store with low_citation_coverage. */
export function lowCitationCoverage(paragraphs: readonly ParagraphCitations[]): boolean {
  return citationCoverage(paragraphs) < 0.6;
}
