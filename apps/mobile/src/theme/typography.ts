import type { TextStyle } from 'react-native';

// Three faces, each with one job (ux-guidelines.md §7.2):
// - Bricolage Grotesque: display and headings. Its quirky, inky shapes carry the app's voice.
// - Figtree: everything you operate (body UI, labels, buttons, metadata). Plain, warm and very legible.
// - Literata: everything you study (lesson text, flashcard faces, explanations). A book face made for long screen
//   reading.
// "Leitura facilitada" swaps all three to Atkinson Hyperlegible and loosens spacing.
export type TypeVariant = 'display' | 'title' | 'heading' | 'body' | 'bodySmall' | 'label' | 'cardFace' | 'reading' | 'caption' | 'mono';

export const FONTS = {
  display: 'BricolageGrotesque_800ExtraBold',
  displayBold: 'BricolageGrotesque_700Bold',
  ui: 'Figtree_400Regular',
  uiMedium: 'Figtree_500Medium',
  uiSemiBold: 'Figtree_600SemiBold',
  uiBold: 'Figtree_700Bold',
  read: 'Literata_400Regular',
  readItalic: 'Literata_400Regular_Italic',
  readMedium: 'Literata_500Medium',
  readBold: 'Literata_700Bold',
  easy: 'AtkinsonHyperlegible_400Regular',
  easyBold: 'AtkinsonHyperlegible_700Bold',
} as const;

const base: Record<TypeVariant, TextStyle> = {
  display: { fontFamily: FONTS.display, fontSize: 32, lineHeight: 36, letterSpacing: -0.6 },
  title: { fontFamily: FONTS.display, fontSize: 24, lineHeight: 29, letterSpacing: -0.3 },
  heading: { fontFamily: FONTS.displayBold, fontSize: 19, lineHeight: 24, letterSpacing: -0.1 },
  body: { fontFamily: FONTS.ui, fontSize: 16, lineHeight: 24 },
  bodySmall: { fontFamily: FONTS.ui, fontSize: 14, lineHeight: 20 },
  label: { fontFamily: FONTS.uiSemiBold, fontSize: 15, lineHeight: 20 },
  cardFace: { fontFamily: FONTS.readMedium, fontSize: 21, lineHeight: 30 },
  reading: { fontFamily: FONTS.read, fontSize: 18, lineHeight: 29 },
  // 12 sp is reserved for legal footnotes (ux §7.2); never used for content.
  caption: { fontFamily: FONTS.ui, fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: 'monospace', fontSize: 14, lineHeight: 20 },
};

/** The bold face that matches a variant: Literata stays Literata, display stays display. */
export function boldFamily(variant: TypeVariant, easyReading: boolean): string {
  if (easyReading) return FONTS.easyBold;
  if (variant === 'cardFace' || variant === 'reading') return FONTS.readBold;
  if (variant === 'display' || variant === 'title' || variant === 'heading') return FONTS.display;
  return FONTS.uiBold;
}

export function typeStyle(variant: TypeVariant, easyReading: boolean): TextStyle {
  const style = base[variant];
  if (!easyReading || variant === 'mono') return style;
  const bold = variant === 'display' || variant === 'title' || variant === 'heading' || variant === 'label';
  const fontSize = style.fontSize ?? 16;
  return {
    ...style,
    fontFamily: bold ? FONTS.easyBold : FONTS.easy,
    letterSpacing: fontSize * 0.05,
    lineHeight: Math.round((style.lineHeight ?? fontSize * 1.5) * 1.2),
  };
}
