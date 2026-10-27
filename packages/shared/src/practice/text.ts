// Answer-text helpers for fill_blank, numeric and problem grading (PRA-01.7, spec 05 §11).
// Pure, platform-neutral. No String.prototype.normalize and no regex lookbehind: both are unreliable
// on Hermes, and the same code must agree on device, in Edge Functions and in the worker.

// Portuguese accented letters mapped to their base letter, keeping the case of the input letter.
const ACCENT_BASE: Readonly<Record<string, string>> = (() => {
  const groups: ReadonlyArray<readonly [string, string]> = [
    ['áàâãäåÁÀÂÃÄÅ', 'a'],
    ['éèêëÉÈÊË', 'e'],
    ['íìîïÍÌÎÏ', 'i'],
    ['óòôõöÓÒÔÕÖ', 'o'],
    ['úùûüÚÙÛÜ', 'u'],
    ['çÇ', 'c'],
    ['ñÑ', 'n'],
    ['ýÿÝ', 'y'],
  ];
  const map: Record<string, string> = {};
  for (const [chars, base] of groups) {
    for (const ch of chars) map[ch] = ch === ch.toLowerCase() ? base : base.toUpperCase();
  }
  return map;
})();

/** Removes accents from precomposed letters and from decomposed combining marks. Keeps case. */
export function stripAccents(text: string): string {
  const withoutMarks = text.replace(/[̀-ͯ]/g, '');
  return Array.from(withoutMarks, (ch) => ACCENT_BASE[ch] ?? ch).join('');
}

/** Canonical form for comparing typed answers: accent-free, lowercase, trimmed, single spaces. */
export function foldAnswer(text: string): string {
  return stripAccents(text).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Damerau–Levenshtein distance (Lowrance–Wagner, unrestricted transpositions) over code points.
 * "ri" → "ir" costs 1, so "mitocôndira" is distance 1 from "mitocondria" (PRA-01.7).
 */
export function damerauLevenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = x.length;
  const m = y.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const maxDist = n + m;
  // d has one extra leading row and column (index 0) holding maxDist, as in the published algorithm.
  const d: number[][] = [];
  for (let i = 0; i < n + 2; i++) d.push(new Array<number>(m + 2).fill(0));
  d[0]![0] = maxDist;
  for (let i = 0; i <= n; i++) {
    d[i + 1]![0] = maxDist;
    d[i + 1]![1] = i;
  }
  for (let j = 0; j <= m; j++) {
    d[0]![j + 1] = maxDist;
    d[1]![j + 1] = j;
  }

  const lastRow = new Map<string, number>();
  for (let i = 1; i <= n; i++) {
    let lastMatchCol = 0;
    for (let j = 1; j <= m; j++) {
      const k = lastRow.get(y[j - 1]!) ?? 0;
      const l = lastMatchCol;
      let cost = 1;
      if (x[i - 1] === y[j - 1]) {
        cost = 0;
        lastMatchCol = j;
      }
      d[i + 1]![j + 1] = Math.min(
        d[i]![j]! + cost, // substitution (or match)
        d[i + 1]![j]! + 1, // insertion
        d[i]![j + 1]! + 1, // deletion
        d[k]![l]! + (i - k - 1) + 1 + (j - l - 1), // transposition
      );
    }
    lastRow.set(x[i - 1]!, i);
  }
  return d[n + 1]![m + 1]!;
}

/**
 * Typo budget for an accepted answer (PRA-01.7, spec 05 §11): distance ≤ 1 for length ≥ 5,
 * ≤ 2 for length ≥ 10, exact (after folding) otherwise. `folded` is the folded accepted answer.
 */
export function maxTypoDistance(folded: string): number {
  const length = Array.from(folded).length;
  if (length >= 10) return 2;
  if (length >= 5) return 1;
  return 0;
}

export interface AnswerMatch {
  /** The accepted spelling that matched, exactly as the item stores it. */
  canonical: string;
  /** `canonical` when the typed text differs from it in spelling, case or accents; otherwise null. */
  typo: string | null;
  /** Damerau–Levenshtein distance between the folded texts. */
  distance: number;
}

/**
 * Matches a typed answer against an accepted list (fill_blank, PRA-01.7). Returns the closest
 * accepted entry within its typo budget, or null. Case- and accent-insensitive by construction.
 */
export function matchAcceptedAnswer(response: string, accepted: readonly string[]): AnswerMatch | null {
  const folded = foldAnswer(response);
  if (folded === '') return null;

  let best: { canonical: string; distance: number } | null = null;
  for (const candidate of accepted) {
    const target = foldAnswer(candidate);
    if (target === '') continue;
    const distance = target === folded ? 0 : damerauLevenshtein(folded, target);
    if (distance > maxTypoDistance(target)) continue;
    if (best === null || distance < best.distance) best = { canonical: candidate, distance };
  }
  if (best === null) return null;

  const typed = response.trim().replace(/\s+/g, ' ');
  return {
    canonical: best.canonical,
    typo: typed === best.canonical ? null : best.canonical,
    distance: best.distance,
  };
}

/**
 * Parses a decimal typed in PT-BR ("9,8") or EN ("9.8"). Returns null when the text is not a plain
 * number literal. Thousands separators are not supported.
 */
export function parseDecimal(raw: string): number | null {
  let text = raw.trim().replace(/\s+/g, '');
  if (/^[+-]?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const SUPERSCRIPT_DIGIT: Readonly<Record<string, string>> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
};

/** Unit comparison for numeric answers (§8.1 `unit`): case, spaces and superscript digits ignored. */
export function sameUnit(typed: string, expected: string): boolean {
  return unitKey(typed) === unitKey(expected);
}

function unitKey(unit: string): string {
  return Array.from(unit.trim().toLowerCase().replace(/\s+/g, ''), (ch) => SUPERSCRIPT_DIGIT[ch] ?? ch).join('');
}
