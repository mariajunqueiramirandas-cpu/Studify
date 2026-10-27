// Câmera Mágica (CAM-01…03): on-device quality checks (spec 11 §8.1), image sizing (§8.2), face pixelation
// (CAM-00.6), the transcription markers and edit ratio of CAM-03, the course match rule (§8.5) and the hint
// ladder policy (§8.3). Pure functions over plain pixel buffers, so the app and the server share them.
import type { CaptureIntent } from '../core/enums.ts';
import { expressionsEquivalent } from '../practice/expression.ts';
import { foldAnswer } from '../practice/text.ts';

/** §8.1 thresholds (tunable). */
export const CAPTURE_QUALITY = {
  /** Variance of the Laplacian on a 1024-px grayscale downscale. */
  blurVariance: 80,
  /** Mean luminance (0–255). */
  darkLuminance: 60,
  /** Share of near-white pixels (> 250) that marks glare. */
  glareRatio: 0.04,
  /** Document tilt in degrees (fallback camera only). */
  tiltDegrees: 15,
  /** Long edge used for the blur measure. */
  analysisLongEdge: 1024,
} as const;

/** §8.2: long edge sent to the API, JPEG quality. */
export const CAPTURE_IMAGE = { longEdge: 1568, jpegQuality: 0.85 } as const;

/** CAM-00.4: pages per capture by intent. */
export function maxCapturePages(intent: CaptureIntent): number {
  return intent === 'add_to_subject' || intent === 'grade_answer' || intent === 'grade_essay' ? 20 : 2;
}

/** CAM-03.5: more than 15% of the characters changed marks "Transcrição editada por você". */
export const HEAVY_EDIT_RATIO = 0.15;

/** §8.4 retention of unsaved explain/solve captures (D-38, default 30 days). */
export const CAPTURE_RETENTION_DAYS = 30;

export type QualityIssue = 'blur' | 'dark' | 'glare' | 'tilt';

export interface ImageStats {
  laplacianVariance: number;
  meanLuminance: number;
  glareRatio: number;
  /** Only known on the fallback camera path. */
  tiltDegrees?: number | null;
}

/** §8.1 checks: each failing check is one retake hint ("Usar mesmo assim" is always possible). */
export function assessImageQuality(stats: ImageStats): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (stats.laplacianVariance < CAPTURE_QUALITY.blurVariance) issues.push('blur');
  if (stats.meanLuminance < CAPTURE_QUALITY.darkLuminance) issues.push('dark');
  if (stats.glareRatio > CAPTURE_QUALITY.glareRatio) issues.push('glare');
  if (stats.tiltDegrees != null && Math.abs(stats.tiltDegrees) > CAPTURE_QUALITY.tiltDegrees) issues.push('tilt');
  return issues;
}

/** Luminance (Rec. 601) of an RGBA buffer as an 8-bit grayscale buffer. */
export function toGrayscale(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
  }
  return gray;
}

/** Variance of the 4-neighbour Laplacian (sharp text has strong edges, blur has weak ones). */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - width]! + gray[i + width]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** All three §8.1 measures from one decoded RGBA image. */
export function imageStats(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): ImageStats {
  const gray = toGrayscale(rgba, width, height);
  let total = 0;
  let bright = 0;
  for (const v of gray) {
    total += v;
    if (v > 250) bright++;
  }
  return {
    laplacianVariance: laplacianVariance(gray, width, height),
    meanLuminance: gray.length ? total / gray.length : 0,
    glareRatio: gray.length ? bright / gray.length : 0,
  };
}

/** Size that fits `longEdge` without upscaling (§8.2). */
export function fitLongEdge(width: number, height: number, longEdge: number = CAPTURE_IMAGE.longEdge): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A region in normalized coordinates (0–1), e.g. a face found by ML Kit or an occlusion mask. */
export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * CAM-00.6: pixelates the given regions in place (mosaic of `block`-pixel cells, grown by 15% so the
 * whole face is covered). Faces are blurred on device before upload; the server never sees them.
 */
export function pixelateRegions(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, boxes: readonly NormalizedBox[], block = 0): void {
  for (const box of boxes) {
    const growX = box.w * 0.15;
    const growY = box.h * 0.15;
    const x0 = Math.max(0, Math.floor((box.x - growX) * width));
    const y0 = Math.max(0, Math.floor((box.y - growY) * height));
    const x1 = Math.min(width, Math.ceil((box.x + box.w + growX) * width));
    const y1 = Math.min(height, Math.ceil((box.y + box.h + growY) * height));
    if (x1 <= x0 || y1 <= y0) continue;
    const cell = block > 0 ? block : Math.max(8, Math.round(Math.min(x1 - x0, y1 - y0) / 6));
    for (let by = y0; by < y1; by += cell) {
      for (let bx = x0; bx < x1; bx += cell) {
        const ex = Math.min(x1, bx + cell);
        const ey = Math.min(y1, by + cell);
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let y = by; y < ey; y++) {
          for (let x = bx; x < ex; x++) {
            const i = (y * width + x) * 4;
            r += rgba[i]!;
            g += rgba[i + 1]!;
            b += rgba[i + 2]!;
            count++;
          }
        }
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        for (let y = by; y < ey; y++) {
          for (let x = bx; x < ex; x++) {
            const i = (y * width + x) * 4;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
          }
        }
      }
    }
  }
}

/**
 * CAM-03.5: share of characters changed between the AI transcription and the confirmed text
 * (Levenshtein distance over the longer length, two-row DP; markers count as characters).
 */
export function editRatio(original: string, confirmed: string): number {
  const a = original;
  const b = confirmed;
  if (a === b) return 0;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return Math.min(1, prev[b.length]! / longest);
}

export interface TranscriptionMarkers {
  /** ⟦palavra?⟧ or ⟦palavra?|alt1|alt2⟧ (CAM-03.3). */
  uncertain: { word: string; alternatives: string[]; index: number }[];
  illegible: number;
  crossedOut: number;
}

/** CAM-03.3 markers in a transcription. */
export function parseTranscriptionMarkers(text: string): TranscriptionMarkers {
  const out: TranscriptionMarkers = { uncertain: [], illegible: 0, crossedOut: 0 };
  for (const match of text.matchAll(/⟦([^⟧]*)⟧/g)) {
    const inner = match[1]!.trim();
    const lower = inner.toLowerCase();
    if (lower === 'ilegível' || lower === 'ilegivel') out.illegible++;
    else if (lower === 'rasura') out.crossedOut++;
    else if (inner.includes('?')) {
      const [word, ...alts] = inner.split('|').map((s) => s.trim());
      out.uncertain.push({ word: (word ?? '').replace(/\?$/, ''), alternatives: alts.filter(Boolean).slice(0, 2), index: match.index ?? 0 });
    }
  }
  return out;
}

/** The text that is graded: markers resolved to the first reading (uncertain) or removed. */
export function stripTranscriptionMarkers(text: string): string {
  return text
    .replace(/⟦([^⟧]*)⟧/g, (_m, inner: string) => {
      const value = inner.trim();
      const lower = value.toLowerCase();
      if (lower === 'ilegível' || lower === 'ilegivel' || lower === 'rasura') return '';
      return (value.split('|')[0] ?? '').replace(/\?$/, '').trim();
    })
    .replace(/[ \t]{2,}/g, ' ');
}

export interface TopicMatchScore {
  node_id: string;
  /** Normalized 0–1 score (sum of page ranks of the topic's pages, scaled by the best). */
  score: number;
}

export type MatchDecision =
  | { kind: 'matched'; node_id: string; confidence: number }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * Spec 11 §8.5 step 4: accept the top topic when its normalized score ≥ 0.35 and ≥ 1.2× the second;
 * top-2 within 10% (or the ratio rule failing above threshold) → the tie-break call; else not in the material.
 */
export function decideTopicMatch(scores: readonly TopicMatchScore[]): MatchDecision {
  const sorted = [...scores].filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top || top.score < 0.35) return { kind: 'none' };
  const second = sorted[1];
  if (!second || top.score >= 1.2 * second.score) return { kind: 'matched', node_id: top.node_id, confidence: Math.min(1, top.score) };
  return { kind: 'ambiguous', candidates: sorted.slice(0, 5).map((s) => s.node_id) };
}

/** §8.3: four hint levels, two for a trivial question. Level 4 is the rest of the solution. */
export function hintLadderLength(trivial: boolean): number {
  return trivial ? 2 : 4;
}

/**
 * CAM-02.10 mastery rule for an answer typed during the hint ladder: a correct attempt before level 3
 * is normal evidence, a wrong attempt is negative evidence, anything after the solution is assisted.
 */
export function cameraAttemptEvidence(correct: boolean, hintsRevealed: number, solutionViewed: boolean): { solutionViewed: boolean; score: number } | null {
  if (!correct) return { solutionViewed: false, score: 0 };
  if (solutionViewed || hintsRevealed >= 3) return { solutionViewed: true, score: 1 };
  return { solutionViewed: false, score: 1 };
}

/** First number in a free answer ("6 N", "x = 3,5", "1.250 kg"): PT-BR comma decimals, dot thousands. */
export function firstNumber(text: string): number | null {
  const match = /-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:[.,]\d+)?/.exec(text.replace(/−/g, '-'));
  if (!match) return null;
  let raw = match[0];
  if (/\.\d{3}(?:,|$)/.test(raw) && raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  else raw = raw.replace(',', '.');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * CAM-02.4 "Tentar responder": compares the student's answer with the ladder's final answer by format.
 * numeric: within 1% (or 1e-6); choice: same letter A–E; expression: equivalent at random points;
 * text: same folded text, or one contains the other (short answers like "mitocôndria").
 */
export function sameSolveAnswer(format: 'numeric' | 'expression' | 'choice' | 'text', expected: string, given: string): boolean {
  const answer = given.trim();
  if (!answer) return false;
  if (format === 'numeric') {
    const a = firstNumber(answer);
    const b = firstNumber(expected);
    if (a === null || b === null) return false;
    return Math.abs(a - b) <= Math.max(1e-6, 0.01 * Math.abs(b));
  }
  if (format === 'choice') {
    const letter = (t: string) => /\b([A-Ea-e])\b/.exec(t.replace(/[().]/g, ' '))?.[1]?.toUpperCase() ?? null;
    const a = letter(answer);
    return a !== null && a === letter(expected);
  }
  if (format === 'expression') {
    const rhs = (t: string) => (t.includes('=') ? t.slice(t.lastIndexOf('=') + 1) : t);
    return expressionsEquivalent(rhs(answer), rhs(expected));
  }
  const a = foldAnswer(answer);
  const b = foldAnswer(expected);
  return a.length > 0 && (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b)));
}
