// Semantic tokens (ux-guidelines.md §8.2). Components use these roles only; raw colors live here.

export type ColorScheme = 'light' | 'dark';

export interface Palette {
  bg: string;
  surface1: string;
  surface2: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  primary: string;
  onPrimary: string;
  primarySoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  focusRing: string;
  calmSurface: string;
  overlay: string;
  /** Lagoon teal, the second accent (Capi's stopwatch): tips, key terms, list markers. */
  lagoon: string;
  /** Lamp yellow: the highlighter on bold study text, stars, small celebrations. */
  lamp: string;
  /** Translucent highlighter stroke laid under bold text in notes. */
  highlight: string;
  /** Capi's fur: warm accents next to the mascot. */
  fur: string;
}

// "Riverbank study nook": reed-paper days and deep-indigo nights, with the book indigo from Capi's art as the
// primary, lagoon teal as the second accent and lamp yellow as the highlighter.
const light: Palette = {
  bg: '#EFF0E7',
  surface1: '#FAFAF5',
  surface2: '#E3E5D8',
  textPrimary: '#1E2033',
  textSecondary: '#555A69',
  border: '#CED2C2',
  primary: '#4A3FD1',
  onPrimary: '#FFFFFF',
  primarySoft: '#E5E3F8',
  success: '#1D7548',
  successSoft: '#DCEEDF',
  warning: '#9C5800',
  warningSoft: '#F8EBCF',
  danger: '#B3362A',
  dangerSoft: '#F7E0DA',
  info: '#0E7470',
  infoSoft: '#D8EDE8',
  focusRing: '#4A3FD1',
  calmSurface: '#E6ECE3',
  overlay: 'rgba(30,32,51,0.45)',
  lagoon: '#0C6F6A',
  lamp: '#E9A62B',
  highlight: 'rgba(242,179,61,0.42)',
  fur: '#A06A3A',
};

const dark: Palette = {
  bg: '#16162A',
  surface1: '#1F1F38',
  surface2: '#2A2A48',
  textPrimary: '#ECEBF5',
  textSecondary: '#A9A8C4',
  border: '#3A3A5E',
  primary: '#B0A9FF',
  onPrimary: '#16162A',
  primarySoft: '#2D2A58',
  success: '#6CD69C',
  successSoft: '#163327',
  warning: '#F4C25E',
  warningSoft: '#372D18',
  danger: '#FF8D7E',
  dangerSoft: '#3B1D24',
  info: '#62D5C8',
  infoSoft: '#15333A',
  focusRing: '#B0A9FF',
  calmSurface: '#191E31',
  overlay: 'rgba(6,6,16,0.62)',
  lagoon: '#62D5C8',
  lamp: '#F4C25E',
  highlight: 'rgba(244,194,94,0.28)',
  fur: '#D29A63',
};

// "Alto contraste" (WEL-04, ux §11) raises borders and secondary text.
const highContrast: Record<ColorScheme, Partial<Palette>> = {
  light: { textSecondary: '#2C3040', border: '#6E7363' },
  dark: { textSecondary: '#E2E1F0', border: '#8D8CB4' },
};

export function getPalette(scheme: ColorScheme, contrast = false): Palette {
  const base = scheme === 'dark' ? dark : light;
  return contrast ? { ...base, ...highContrast[scheme] } : base;
}

// 8 dp scale with the 4 dp half step (ux §7.1).
// `gutter` is the page margin: content, the footer bar and sheets all line up on it.
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, gutter: 20, xl: 24, xxl: 32, xxxl: 48 } as const;
/** Mixes a #RRGGBB colour towards black (amount > 0) or white (amount < 0); the ledge under tactile controls. */
export function shade(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const target = amount > 0 ? 0 : 255;
  const a = Math.min(1, Math.abs(amount));
  const ch = (v: number) => Math.round(v + (target - v) * a).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

/** Depth of the ledge under pressable things; pressing sinks the face onto it. */
export const depth = { sm: 3, md: 4, lg: 6 } as const;

// Corners grow with the size of the thing: small controls are nearly square, sheets are soft. No capsules.
export const radius = { xs: 4, sm: 6, md: 10, lg: 14, xl: 22, round: 999 } as const;
export const touch = { min: 48, option: 56 } as const;
export const maxContentWidth = 600;

// ux §8.3: twelve subject hues (Tailwind 600 for light, 400 for dark). Accent use only.
export const SUBJECT_COLORS = {
  indigo: { light: '#4F46E5', dark: '#818CF8', label: 'Anil' },
  blue: { light: '#2563EB', dark: '#60A5FA', label: 'Azul' },
  sky: { light: '#0284C7', dark: '#38BDF8', label: 'Céu' },
  teal: { light: '#0D9488', dark: '#2DD4BF', label: 'Turquesa' },
  green: { light: '#16A34A', dark: '#4ADE80', label: 'Verde' },
  lime: { light: '#65A30D', dark: '#A3E635', label: 'Lima' },
  amber: { light: '#D97706', dark: '#FBBF24', label: 'Âmbar' },
  orange: { light: '#EA580C', dark: '#FB923C', label: 'Laranja' },
  red: { light: '#DC2626', dark: '#F87171', label: 'Vermelho' },
  pink: { light: '#DB2777', dark: '#F472B6', label: 'Rosa' },
  purple: { light: '#9333EA', dark: '#C084FC', label: 'Roxo' },
  slate: { light: '#475569', dark: '#94A3B8', label: 'Cinza' },
} as const;
export type SubjectColor = keyof typeof SUBJECT_COLORS;
export const SUBJECT_COLOR_KEYS = Object.keys(SUBJECT_COLORS) as SubjectColor[];

export function subjectColor(key: string | null | undefined, scheme: ColorScheme): string {
  const entry = SUBJECT_COLORS[(key ?? 'indigo') as SubjectColor] ?? SUBJECT_COLORS.indigo;
  return entry[scheme];
}

// Subject icons (Ionicons names) offered in S-MAT-02.
export const SUBJECT_ICONS = [
  'book-outline',
  'flask-outline',
  'calculator-outline',
  'leaf-outline',
  'globe-outline',
  'earth-outline',
  'language-outline',
  'musical-notes-outline',
  'color-palette-outline',
  'barbell-outline',
  'hardware-chip-outline',
  'library-outline',
  'planet-outline',
  'pulse-outline',
  'chatbubbles-outline',
  'school-outline',
] as const;

// Mastery ramp (ux §8.2): single hue from primary to border, always paired with a label.
export const MASTERY_LEVELS = [
  { min: 0.85, key: 'strong', label: 'Forte' },
  { min: 0.65, key: 'ok', label: 'Ok' },
  { min: 0.45, key: 'fading', label: 'Apagando' },
  { min: 0, key: 'almost_forgotten', label: 'Quase esquecido' },
] as const;

export function masteryColor(value: number | null | undefined, p: Palette): string {
  if (value == null) return p.border;
  const alpha = Math.round((0.25 + 0.75 * Math.max(0, Math.min(1, value))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${p.primary}${alpha}`;
}

export function masteryLabel(value: number | null | undefined): string {
  if (value == null) return 'Ainda não estudado';
  return (MASTERY_LEVELS.find((l) => value >= l.min) ?? MASTERY_LEVELS[MASTERY_LEVELS.length - 1]!).label;
}
