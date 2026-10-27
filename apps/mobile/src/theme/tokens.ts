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
}

const light: Palette = {
  bg: '#FFFFFF',
  surface1: '#F7F7FA',
  surface2: '#EEEEF3',
  textPrimary: '#111827',
  textSecondary: '#4B5563',
  border: '#D1D5DB',
  primary: '#4F46E5',
  onPrimary: '#FFFFFF',
  primarySoft: '#EEF2FF',
  success: '#15803D',
  successSoft: '#ECFDF3',
  warning: '#B45309',
  warningSoft: '#FFF7E6',
  danger: '#B91C1C',
  dangerSoft: '#FEF2F2',
  info: '#1D4ED8',
  infoSoft: '#EFF6FF',
  focusRing: '#4F46E5',
  calmSurface: '#F2F6F5',
  overlay: 'rgba(17,24,39,0.45)',
};

const dark: Palette = {
  bg: '#0F1115',
  surface1: '#171A21',
  surface2: '#1F232C',
  textPrimary: '#F3F4F6',
  textSecondary: '#9CA3AF',
  border: '#2D3340',
  primary: '#A5B4FC',
  onPrimary: '#111827',
  primarySoft: '#1E2140',
  success: '#4ADE80',
  successSoft: '#11291C',
  warning: '#FBBF24',
  warningSoft: '#2C2210',
  danger: '#F87171',
  dangerSoft: '#2E1416',
  info: '#60A5FA',
  infoSoft: '#122036',
  focusRing: '#A5B4FC',
  calmSurface: '#141B1A',
  overlay: 'rgba(0,0,0,0.6)',
};

// "Alto contraste" (WEL-04, ux §11) raises borders and secondary text.
const highContrast: Record<ColorScheme, Partial<Palette>> = {
  light: { textSecondary: '#1F2937', border: '#6B7280' },
  dark: { textSecondary: '#E5E7EB', border: '#9CA3AF' },
};

export function getPalette(scheme: ColorScheme, contrast = false): Palette {
  const base = scheme === 'dark' ? dark : light;
  return contrast ? { ...base, ...highContrast[scheme] } : base;
}

// 8 dp scale with the 4 dp half step (ux §7.1).
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;
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
