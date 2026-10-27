// Positioned text spans for the in-app highlight (ING-08.3, spec 01 §8.7). The output contract is fixed
// by the mobile app (apps/mobile highlight.ts): `{ "spans": [{ "text", "x", "y", "w", "h" }] }` with x/y/w/h
// normalized to 0–1 and the origin at the TOP-LEFT of the page. Pure functions: no pdfjs import.

export interface TextSpanOut {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpansFile {
  spans: TextSpanOut[];
}

/** PDF.js text item (only the fields used here). */
export interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
}

/** Multiplies two affine matrices in PDF.js order [a b c d e f] (same result as Util.transform). */
export function multiplyTransform(m1: readonly number[], m2: readonly number[]): number[] {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!,
  ];
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Converts one text item to a normalized top-left box. `viewport` is the page viewport at scale 1
 * (its transform maps PDF user space to device pixels with the origin at the top-left).
 * Returns null for empty or degenerate items.
 */
export function normalizeTextItem(
  item: RawTextItem,
  viewport: { transform: readonly number[]; width: number; height: number },
): TextSpanOut | null {
  const text = item.str;
  if (!text || !text.trim()) return null;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const device = multiplyTransform(viewport.transform, item.transform);
  const fontSize = Math.hypot(device[2] ?? 0, device[3] ?? 0);
  const scale = Math.hypot(viewport.transform[0] ?? 1, viewport.transform[1] ?? 0);
  const left = device[4] ?? 0;
  const baseline = device[5] ?? 0;
  const width = Math.max(0, item.width * scale);
  if (![left, baseline, fontSize, width].every((v) => Number.isFinite(v))) return null;
  if (fontSize <= 0) return null;
  // The baseline is the bottom of the text box in device space; the box grows upwards by the font size.
  const top = baseline - fontSize;
  return {
    text,
    x: round4(clamp01(left / viewport.width)),
    y: round4(clamp01(top / viewport.height)),
    w: round4(clamp01(width / viewport.width)),
    h: round4(clamp01(fontSize / viewport.height)),
  };
}

export function spansFile(spans: readonly TextSpanOut[]): SpansFile {
  return { spans: [...spans] };
}
