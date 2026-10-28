// Where Capi's head, eyes and neck sit in each illustration (spec 13 §5.2), in the 1024 × 1024 space of the
// source art. The accessories (MOT-03.2) are drawn on top from these points, so a new pose only needs its anchors.
import type { CapiMood, CapiSlot, CapiStage } from '@studify/shared';

export type Point = readonly [number, number];

export interface CapiPose {
  /** Visible eyes, screen-left first. */
  eyes: readonly [Point, Point];
  /** Ear tips, screen-left first: their distance sets the accessory scale, their slope the head tilt. */
  ears: readonly [Point, Point];
  /** Top of the head, between the ears. */
  top: Point;
  /** Under the chin; null when a book or paw covers the neck. */
  neck: Point | null;
}

export const CAPI_POSES: Record<`${CapiStage}_${CapiMood}`, CapiPose> = {
  filhote_celebrating: { eyes: [[424, 228], [620, 372]], ears: [[447, 128], [760, 261]], top: [587, 175], neck: [585, 600] },
  filhote_curious: { eyes: [[380, 287], [620, 363]], ears: [[413, 127], [787, 253]], top: [587, 167], neck: [575, 655] },
  filhote_focused: { eyes: [[357, 308], [600, 375]], ears: [[407, 121], [773, 221]], top: [573, 141], neck: null },
  filhote_resting: { eyes: [[353, 296], [620, 393]], ears: [[407, 113], [787, 247]], top: [587, 133], neck: [590, 690] },
  // The sleepy filhote is the resting pose with the moon and Zzz added.
  filhote_sleepy: { eyes: [[353, 296], [620, 393]], ears: [[407, 113], [787, 247]], top: [587, 133], neck: [590, 690] },
  jovem_celebrating: { eyes: [[413, 197], [600, 261]], ears: [[453, 81], [700, 161]], top: [573, 115], neck: [520, 433] },
  jovem_curious: { eyes: [[407, 173], [587, 237]], ears: [[453, 67], [700, 140]], top: [573, 96], neck: [533, 440] },
  jovem_focused: { eyes: [[397, 199], [580, 245]], ears: [[433, 75], [700, 155]], top: [560, 101], neck: null },
  jovem_resting: { eyes: [[424, 200], [607, 251]], ears: [[460, 83], [720, 147]], top: [587, 107], neck: [560, 460] },
  jovem_sleepy: { eyes: [[427, 221], [607, 275]], ears: [[460, 101], [720, 188]], top: [587, 135], neck: [560, 488] },
  adulta_celebrating: { eyes: [[440, 133], [611, 180]], ears: [[460, 47], [707, 153]], top: [573, 83], neck: [533, 440] },
  adulta_curious: { eyes: [[403, 171], [587, 227]], ears: [[447, 61], [700, 155]], top: [560, 88], neck: [520, 420] },
  adulta_focused: { eyes: [[407, 209], [587, 260]], ears: [[447, 93], [707, 167]], top: [573, 113], neck: null },
  adulta_resting: { eyes: [[420, 208], [593, 272]], ears: [[460, 75], [720, 161]], top: [573, 115], neck: [547, 427] },
  adulta_sleepy: { eyes: [[400, 197], [593, 257]], ears: [[460, 60], [713, 160]], top: [573, 96], neck: [533, 460] },
  sabia_celebrating: { eyes: [[433, 140], [613, 180]], ears: [[460, 60], [707, 133]], top: [587, 91], neck: [533, 447] },
  sabia_curious: { eyes: [[407, 179], [587, 235]], ears: [[440, 75], [713, 148]], top: [573, 95], neck: [533, 441] },
  sabia_focused: { eyes: [[397, 207], [583, 253]], ears: [[440, 80], [707, 147]], top: [573, 100], neck: null },
  sabia_resting: { eyes: [[407, 195], [587, 241]], ears: [[440, 81], [727, 155]], top: [573, 108], neck: [547, 448] },
  sabia_sleepy: { eyes: [[400, 203], [591, 251]], ears: [[447, 87], [700, 160]], top: [573, 113], neck: [547, 460] },
};

export interface ArtShape {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

const OUTLINE = '#3A2416';
const LINE = 11;

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
}

/** A leaf along `angle` (degrees, 0 = up) from (x, y). */
function leaf(x: number, y: number, angle: number, len: number, w: number): string {
  const a = (angle * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const tip = [x + ux * len, y + uy * len];
  const mid = [x + ux * len * 0.5, y + uy * len * 0.5];
  const side = (s: number) => [mid[0]! - uy * w * s, mid[1]! + ux * w * s];
  const [l, r] = [side(1), side(-1)];
  return `M${x} ${y} Q${l[0]} ${l[1]} ${tip[0]} ${tip[1]} Q${r[0]} ${r[1]} ${x} ${y} Z`;
}

/**
 * Hats in head space: origin on the top of the head, y down, sized for ears 270 apart. Drawn in the art's own
 * style: flat fills with a dark brown outline.
 */
export const HATS: Record<string, ArtShape[]> = {
  bone: [
    { d: 'M-118 -30 Q-210 -34 -232 -6 Q-170 4 -104 -6 Z', fill: '#C2412F', stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M-122 -2 C-126 -112 122 -112 122 -2 Q0 -26 -122 -2 Z', fill: '#E25C4B', stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M-4 -84 Q-16 -46 -8 -16', stroke: OUTLINE, strokeWidth: 6 },
    { d: circle(0, -86, 11), fill: '#C2412F', stroke: OUTLINE, strokeWidth: 7 },
  ],
  chapeu_formatura: [
    { d: 'M-92 6 L-86 -52 Q0 -36 86 -52 L92 6 Q0 24 -92 6 Z', fill: '#2B2E3D', stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M-176 -62 L0 -124 L176 -62 L0 -4 Z', fill: '#1F2231', stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M0 -62 Q104 -50 132 2', stroke: '#F2B33D', strokeWidth: 9 },
    { d: 'M118 -4 L146 -4 L154 52 L112 52 Z', fill: '#F2B33D', stroke: OUTLINE, strokeWidth: 7 },
    { d: circle(0, -62, 10), fill: '#F2B33D', stroke: OUTLINE, strokeWidth: 6 },
  ],
  coroa_folhas: [
    { d: 'M-128 -4 Q0 -46 128 -4', stroke: '#2F6B3F', strokeWidth: 12 },
    ...[-78, -54, -30, -8, 14, 36, 58, 80].map((angle, i) => {
      const x = angle * 1.62;
      const y = -4 - Math.cos((angle * Math.PI) / 180) * 38;
      return { d: leaf(x, y, angle * 1.15 + (i % 2 ? 18 : -18), i % 2 ? 56 : 64, 24), fill: i % 2 ? '#4CA867' : '#2F8550', stroke: OUTLINE, strokeWidth: 8 };
    }),
  ],
  gorro_chefao: [
    { d: 'M-128 4 Q-134 -108 0 -114 Q134 -108 128 4 Z', fill: '#7A4FD0', stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M-40 -100 Q-46 -50 -40 -8 M40 -100 Q46 -50 40 -8', stroke: '#5B36A8', strokeWidth: 8 },
    { d: 'M-140 -26 Q0 -44 140 -26 L142 18 Q0 2 -142 18 Z', fill: '#5B36A8', stroke: OUTLINE, strokeWidth: LINE },
    { d: circle(0, -122, 30), fill: '#F2B33D', stroke: OUTLINE, strokeWidth: 9 },
  ],
};

/** Lens and frame colours; the lenses are drawn around each eye, the bridge and arm between them. */
export const GLASSES: Record<string, { frame: string; lens: string; round: boolean }> = {
  oculos: { frame: '#3B3F4A', lens: 'rgba(255,255,255,0.18)', round: false },
  oculos_redondos: { frame: '#C9962B', lens: 'rgba(255,255,255,0.18)', round: true },
  oculos_sol: { frame: '#1E1E28', lens: '#23232E', round: true },
};

/** Scarf in neck space: origin under the chin, y down, sized for ears 270 apart; the tail hangs on the right. */
export function scarfShapes(color: string, shade: string): ArtShape[] {
  return [
    { d: 'M64 30 L112 22 L136 150 L92 158 Z', fill: color, stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M100 84 L130 80 M106 116 L134 112', stroke: shade, strokeWidth: 9 },
    { d: 'M-150 -22 Q0 22 150 -22 L156 32 Q0 82 -156 32 Z', fill: color, stroke: OUTLINE, strokeWidth: LINE },
    { d: 'M-120 4 Q0 40 120 4', stroke: shade, strokeWidth: 8 },
  ];
}

/** How far the hat sinks onto the head, in head space. */
const HAT_DROP = 44;
/** How far the scarf sits below the neck point, in neck space. */
const SCARF_DROP = 0;

const deg = (r: number) => (r * 180) / Math.PI;

function glassesShapes(eyes: readonly [Point, Point], style: { frame: string; lens: string; round: boolean }): ArtShape[] {
  const [[lx, ly], [rx, ry]] = eyes;
  const dist = Math.hypot(rx - lx, ry - ly);
  const ux = (rx - lx) / dist;
  const uy = (ry - ly) / dist;
  const r = dist * (style.round ? 0.27 : 0.3);
  const lens = (x: number, y: number) =>
    style.round ? circle(x, y, r) : `M${x - r} ${y - r * 0.78} h${2 * r} v${1.56 * r} h${-2 * r} Z`;
  // Bridge between the lenses, arm from the far lens back towards the ear.
  const bridge = `M${lx + ux * r} ${ly + uy * r} Q${(lx + rx) / 2 - uy * r * 0.35} ${(ly + ry) / 2 + ux * r * 0.35 - r * 0.25} ${rx - ux * r} ${ry - uy * r}`;
  const arm = `M${rx + ux * r} ${ry + uy * r - r * 0.2} L${rx + ux * r * 2.3} ${ry + uy * r * 2.3 - r * 0.55}`;
  const w = Math.max(7, dist * 0.05);
  return [
    { d: lens(lx, ly), fill: style.lens, stroke: style.frame, strokeWidth: w },
    { d: lens(rx, ry), fill: style.lens, stroke: style.frame, strokeWidth: w },
    { d: bridge, stroke: style.frame, strokeWidth: w },
    { d: arm, stroke: style.frame, strokeWidth: w },
    ...(style.lens.startsWith('#') ? [{ d: `M${lx - r * 0.45} ${ly - r * 0.35} l${r * 0.3} ${-r * 0.2} M${rx - r * 0.45} ${ry - r * 0.35} l${r * 0.3} ${-r * 0.2}`, stroke: 'rgba(255,255,255,0.7)', strokeWidth: w * 0.8 }] : []),
  ];
}

export interface ArtLayer {
  transform?: string;
  shapes: ArtShape[];
}

/** The accessory drawings for one pose, back to front: scarf, glasses, hat. */
export function accessoryArt(pose: CapiPose, accessories: readonly { id: string; slot: CapiSlot; color?: string }[]): ArtLayer[] {
  const [[ex1, ey1], [ex2, ey2]] = pose.ears;
  const scale = Math.hypot(ex2 - ex1, ey2 - ey1) / 270;
  const tilt = deg(Math.atan2(ey2 - ey1, ex2 - ex1));
  const layers: ArtLayer[] = [];
  const scarf = accessories.find((a) => a.slot === 'scarf');
  if (scarf?.color && pose.neck) {
    const [nx, ny] = pose.neck;
    layers.push({ transform: `translate(${nx} ${ny}) rotate(${tilt * 0.4}) scale(${scale}) translate(0 ${SCARF_DROP})`, shapes: scarfShapes(scarf.color, 'rgba(0,0,0,0.18)') });
  }
  const glasses = accessories.find((a) => a.slot === 'glasses');
  const style = glasses && GLASSES[glasses.id];
  if (style) layers.push({ shapes: glassesShapes(pose.eyes, style) });
  const hat = accessories.find((a) => a.slot === 'hat');
  const hatShapes = hat && HATS[hat.id];
  if (hatShapes) {
    const [tx, ty] = pose.top;
    layers.push({ transform: `translate(${tx} ${ty}) rotate(${tilt * 0.8}) scale(${scale}) translate(0 ${HAT_DROP})`, shapes: hatShapes });
  }
  return layers;
}
