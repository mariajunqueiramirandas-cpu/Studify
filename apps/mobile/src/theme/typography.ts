import type { TextStyle } from 'react-native';

// ux-guidelines.md §7.2. Nunito for display/titles, Inter for body; "Leitura facilitada"
// swaps everything to Atkinson Hyperlegible and loosens spacing.
export type TypeVariant = 'display' | 'title' | 'heading' | 'body' | 'bodySmall' | 'label' | 'cardFace' | 'caption' | 'mono';

export const FONT_FILES = {
  'Nunito-Bold': 'Nunito_700Bold',
  'Nunito-SemiBold': 'Nunito_600SemiBold',
  'Inter-Regular': 'Inter_400Regular',
  'Inter-Medium': 'Inter_500Medium',
  'Inter-SemiBold': 'Inter_600SemiBold',
  'Atkinson-Regular': 'AtkinsonHyperlegible_400Regular',
  'Atkinson-Bold': 'AtkinsonHyperlegible_700Bold',
} as const;

const base: Record<TypeVariant, TextStyle> = {
  display: { fontFamily: 'Nunito_700Bold', fontSize: 28, lineHeight: 34 },
  title: { fontFamily: 'Nunito_700Bold', fontSize: 22, lineHeight: 28 },
  heading: { fontFamily: 'Nunito_600SemiBold', fontSize: 18, lineHeight: 24 },
  body: { fontFamily: 'Inter_400Regular', fontSize: 16, lineHeight: 24 },
  bodySmall: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 20 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 14, lineHeight: 20 },
  cardFace: { fontFamily: 'Inter_500Medium', fontSize: 20, lineHeight: 28 },
  // 12 sp is reserved for legal footnotes (ux §7.2); never used for content.
  caption: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: 'monospace', fontSize: 14, lineHeight: 20 },
};

export function typeStyle(variant: TypeVariant, easyReading: boolean): TextStyle {
  const style = base[variant];
  if (!easyReading || variant === 'mono') return style;
  const bold = variant === 'display' || variant === 'title' || variant === 'heading' || variant === 'label';
  const fontSize = style.fontSize ?? 16;
  return {
    ...style,
    fontFamily: bold ? 'AtkinsonHyperlegible_700Bold' : 'AtkinsonHyperlegible_400Regular',
    letterSpacing: fontSize * 0.05,
    lineHeight: Math.round((style.lineHeight ?? fontSize * 1.5) * 1.2),
  };
}
