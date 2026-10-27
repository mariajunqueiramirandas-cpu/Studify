/**
 * ING-08 highlight: page text spans (worker output in the `page-text` bucket) carry normalized
 * bounding boxes. Contract: `{ "spans": [{ "text": string, "x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1 }] }`.
 * The cited text is fuzzy-matched against the spans; if matching fails the page opens without
 * a highlight — never an error (mobile-app.md §7).
 */
export interface PageSpan {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Returns the spans covering the best window of words matching `cited`. */
export function matchSpans(spans: PageSpan[], cited: string | null | undefined): PageSpan[] {
  if (!cited || !spans.length) return [];
  const target = norm(cited).split(' ').filter(Boolean);
  if (target.length < 2) return [];
  const words: { word: string; span: number }[] = [];
  spans.forEach((s, i) => norm(s.text).split(' ').filter(Boolean).forEach((w) => words.push({ word: w, span: i })));
  const targetSet = new Set(target);
  const win = target.length;
  let best = { score: 0, start: -1 };
  for (let i = 0; i + Math.min(win, words.length) <= words.length; i++) {
    let score = 0;
    for (let j = 0; j < win && i + j < words.length; j++) if (targetSet.has(words[i + j]!.word)) score++;
    if (score > best.score) best = { score, start: i };
  }
  // Require at least 60% of the cited words to land in the window.
  if (best.start < 0 || best.score / win < 0.6) return [];
  const ids = new Set(words.slice(best.start, best.start + win).map((w) => w.span));
  return [...ids].sort((a, b) => a - b).map((i) => spans[i]!);
}
