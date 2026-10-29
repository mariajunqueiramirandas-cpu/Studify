// Small text helpers shared by ingestion: normalization for duplicate detection (spec 01 §8.5, ING-05),
// character counts for scanned detection (spec 01 §8.3).

/** lowercase, accents and punctuation removed, whitespace collapsed (spec 01 §8.5 concept de-duplication). */
export function normalizeTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Non-whitespace characters, used by the scanned-page rule (fewer than 20 means scanned). */
export function nonWhitespaceCount(value: string): number {
  let n = 0;
  for (const ch of value) if (!/\s/.test(ch)) n++;
  return n;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
