import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import { getPalette, type ColorScheme, type Palette } from './tokens';
import { typeStyle, type TypeVariant } from './typography';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Theme {
  scheme: ColorScheme;
  colors: Palette;
  easyReading: boolean;
  highContrast: boolean;
  reduceMotion: boolean;
  type: (variant: TypeVariant) => ReturnType<typeof typeStyle>;
}

const ThemeContext = createContext<Theme | null>(null);

interface Props {
  preference?: ThemePreference;
  easyReading?: boolean;
  highContrast?: boolean;
  /** "Reduzir animações" in S-PERF-09; the OS setting is always honored as well. */
  reduceMotion?: boolean;
  children: ReactNode;
}

export function ThemeProvider({ preference = 'system', easyReading = false, highContrast = false, reduceMotion = false, children }: Props) {
  const system = useColorScheme();
  const [osReduceMotion, setOsReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setOsReduceMotion).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOsReduceMotion);
    return () => sub.remove();
  }, []);

  const scheme: ColorScheme = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;

  const theme = useMemo<Theme>(
    () => ({
      scheme,
      colors: getPalette(scheme, highContrast),
      easyReading,
      highContrast,
      reduceMotion: reduceMotion || osReduceMotion,
      type: (variant) => typeStyle(variant, easyReading),
    }),
    [scheme, highContrast, easyReading, reduceMotion, osReduceMotion],
  );

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider');
  return theme;
}
