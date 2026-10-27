// Image-occlusion cards (MEM-03): mask suggestions from on-device text recognition (MEM-03.2), one card per
// mask sharing a sibling group (MEM-03.4), and what to draw while reviewing (MEM-03.3, MEM-03.5). The masks
// use normalized coordinates (MEM-03.6), so a card renders the same on every screen. No AI involved.
import type { NormalizedBox } from './camera.ts';

export type OcclusionMode = 'hide_one' | 'hide_all';

export interface OcclusionMask extends NormalizedBox {
  id: string;
  label: string;
}

export interface OcclusionBase {
  path: string;
  width: number;
  height: number;
}

export interface OcclusionCardMedia extends OcclusionBase {
  mode: OcclusionMode;
  masks: OcclusionMask[];
  target_mask_id: string;
}

/** Masks smaller than 1% of the image side are dropped as accidental taps. */
export const MIN_MASK_SIDE = 0.01;
/** MEM-03.3: default mode. */
export const DEFAULT_OCCLUSION_MODE: OcclusionMode = 'hide_all';

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Clamps a box into the image and rejects degenerate ones. */
export function normalizeMask(mask: OcclusionMask): OcclusionMask | null {
  const x = clamp01(mask.x);
  const y = clamp01(mask.y);
  const w = clamp01(Math.min(mask.w, 1 - x));
  const h = clamp01(Math.min(mask.h, 1 - y));
  if (w < MIN_MASK_SIDE || h < MIN_MASK_SIDE) return null;
  return { ...mask, x, y, w, h, label: mask.label.trim() };
}

/** A text block from ML Kit, in image pixels. */
export interface RecognizedTextBox {
  text: string;
  frame: { left: number; top: number; width: number; height: number };
}

/**
 * MEM-03.2: proposed masks from recognized text — labels of 1 to 6 words (diagram labels), sorted top to
 * bottom then left to right, with ids m1, m2, … The user toggles, resizes or adds masks afterwards.
 */
export function suggestMasks(boxes: readonly RecognizedTextBox[], imageWidth: number, imageHeight: number): OcclusionMask[] {
  const candidates = boxes
    .map((b) => ({ text: b.text.replace(/\s+/g, ' ').trim(), f: b.frame }))
    .filter((b) => {
      const words = b.text.split(' ').filter(Boolean).length;
      return b.text.length >= 2 && words >= 1 && words <= 6;
    })
    .sort((a, b) => a.f.top - b.f.top || a.f.left - b.f.left);
  const out: OcclusionMask[] = [];
  for (const c of candidates) {
    const mask = normalizeMask({
      id: `m${out.length + 1}`,
      label: c.text,
      x: c.f.left / imageWidth,
      y: c.f.top / imageHeight,
      w: c.f.width / imageWidth,
      h: c.f.height / imageHeight,
    });
    if (mask) out.push(mask);
  }
  return out;
}

/** MEM-03.4: one card media per labeled mask; all cards of an image share a sibling group. */
export function occlusionCardsFor(base: OcclusionBase, masks: readonly OcclusionMask[], mode: OcclusionMode = DEFAULT_OCCLUSION_MODE): OcclusionCardMedia[] {
  const valid = masks.map(normalizeMask).filter((m): m is OcclusionMask => m !== null && m.label.length > 0);
  return valid.map((target) => ({ ...base, mode, masks: valid, target_mask_id: target.id }));
}

/** Front and back text of an occlusion card (the image carries the content). */
export function occlusionCardText(media: Pick<OcclusionCardMedia, 'masks' | 'target_mask_id'>): { front: string; back: string } {
  const target = media.masks.find((m) => m.id === media.target_mask_id);
  return { front: 'O que está escondido na área destacada?', back: target?.label ?? '' };
}

export interface MaskRender {
  mask: OcclusionMask;
  /** Covered by an opaque box. */
  hidden: boolean;
  /** The asked mask, drawn with the highlight colour. */
  target: boolean;
}

/**
 * MEM-03.3/03.5: "Esconder um" hides only the asked mask; "Esconder todos" hides every mask and highlights the
 * asked one. After "Mostrar resposta" only the other masks of hide_all stay covered.
 */
export function masksToRender(media: Pick<OcclusionCardMedia, 'masks' | 'target_mask_id' | 'mode'>, revealed: boolean): MaskRender[] {
  return media.masks.map((mask) => {
    const target = mask.id === media.target_mask_id;
    const hidden = target ? !revealed : media.mode === 'hide_all';
    return { mask, hidden, target };
  });
}
