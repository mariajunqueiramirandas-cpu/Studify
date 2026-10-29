import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Tactile, Text, type IconName } from '../../components';
import { depth, radius, space, useTheme } from '../../theme';

interface NotebookProps {
  name: string;
  /** The subject's hue for the current scheme. */
  tint: string;
  icon: string | null | undefined;
  /** Lines under the name on the label (next test, Turma). */
  children?: ReactNode;
  /** Top-right corner (the pin). */
  corner?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A subject as a notebook (ux §9): a cover in the subject's hue with a stiff binding, an emblem, and a paper label
 * stuck on it holding the name. Matérias shelves them; the subject form shows one as a live preview.
 */
export function Notebook({ name, tint, icon, children, corner, onPress, accessibilityLabel, style }: NotebookProps) {
  const { colors, scheme } = useTheme();
  const body = (
    <>
      <View style={styles.top}>
        <View style={[styles.emblem, { backgroundColor: tint }]}>
          <Ionicons name={(icon ?? 'book-outline') as IconName} size={22} color={colors.onPrimary} />
        </View>
        {corner}
      </View>
      <View style={[styles.label, { backgroundColor: colors.surface1, borderColor: `${tint}55` }]}>
        <Text variant="heading" numberOfLines={2}>
          {name}
        </Text>
        {children}
      </View>
    </>
  );
  const face = `${tint}${scheme === 'dark' ? '2E' : '1F'}`;
  if (!onPress) {
    return (
      <View style={[styles.cover, { backgroundColor: face, borderLeftColor: tint, borderBottomColor: tint, borderBottomWidth: depth.md }, style]} accessible accessibilityLabel={accessibilityLabel ?? name}>
        {body}
      </View>
    );
  }
  return (
    <Tactile onPress={onPress} accessibilityLabel={accessibilityLabel ?? name} color={face} ledge={tint} depth={depth.md} style={[styles.cover, { borderLeftColor: tint }, style]}>
      {body}
    </Tactile>
  );
}

const styles = StyleSheet.create({
  // A notebook: a stiff binding on the left, soft corners on the opening side.
  cover: {
    minHeight: 148,
    padding: space.md,
    paddingLeft: space.md + 2,
    borderLeftWidth: 7,
    borderTopLeftRadius: radius.xs,
    borderBottomLeftRadius: radius.xs,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    justifyContent: 'space-between',
    gap: space.md,
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  emblem: { width: 38, height: 38, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
  // The paper label stuck on the cover.
  label: { borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.xxs },
});
