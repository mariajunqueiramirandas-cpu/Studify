import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme, type TypeVariant } from '../theme';

type Tone = 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'onPrimary';

export interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  tone?: Tone;
  align?: TextStyle['textAlign'];
  weight?: 'regular' | 'bold';
}

/** Every text in the app goes through here: theme colors, type scale, Leitura facilitada, font scaling. */
export function Text({ variant = 'body', tone = 'primary', align, weight, style, ...rest }: AppTextProps) {
  const theme = useTheme();
  const c = theme.colors;
  const color = {
    primary: c.textPrimary,
    secondary: c.textSecondary,
    accent: c.primary,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    info: c.info,
    onPrimary: c.onPrimary,
  }[tone];
  const boldFamily = theme.easyReading ? 'AtkinsonHyperlegible_700Bold' : 'Inter_600SemiBold';
  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={2}
      style={[theme.type(variant), { color, textAlign: align }, weight === 'bold' && { fontFamily: boldFamily }, style]}
      {...rest}
    />
  );
}

/**
 * Renders the small subset of Markdown allowed in catalog strings (`**bold**`, `*italic*`),
 * e.g. "Você tem **12 cartões** pra revisar".
 */
export function RichText({ children, ...props }: Omit<AppTextProps, 'children'> & { children: string }) {
  const theme = useTheme();
  const parts = children.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  const bold = theme.easyReading ? 'AtkinsonHyperlegible_700Bold' : 'Inter_600SemiBold';
  return (
    <Text {...props}>
      {parts.map((part, i) => {
        if (part.startsWith('**')) return <Text key={i} {...props} style={[props.style, { fontFamily: bold }]}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('*')) return <Text key={i} {...props} style={[props.style, { fontStyle: 'italic' }]}>{part.slice(1, -1)}</Text>;
        return part;
      })}
    </Text>
  );
}
