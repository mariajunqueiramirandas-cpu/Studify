import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { Text } from './Text';

/** Where the thing that opened a popover sits on screen, in window coordinates (dp). */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ARROW = 9;
const GAP = 6;

/**
 * A card that floats next to what was tapped, with a small arrow pointing at it: below the word when there is room,
 * above it otherwise. The word itself stays lit under a soft frame so the eye never loses its place. Without an
 * anchor (a list row, a screen reader) it floats in the middle of the screen.
 */
export function Popover({ visible, anchor, onClose, children, maxWidth = 340 }: { visible: boolean; anchor: Anchor | null; onClose: () => void; children: ReactNode; maxWidth?: number }) {
  const { colors: c } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: anchor ? 'rgba(0,0,0,0.18)' : c.overlay }]} onPress={onClose} accessibilityLabel={t('global.close')} />
      {anchor ? (
        <View
          pointerEvents="none"
          style={[
            styles.spot,
            { left: anchor.x - 4, top: anchor.y - 2, width: anchor.width + 8, height: anchor.height + 4, borderColor: c.lagoon, backgroundColor: `${c.lagoon}26` },
          ]}
        />
      ) : null}
      {/* Mounted per opening, so each one measures itself afresh and springs in from its word. */}
      {visible ? (
        <FloatingCard anchor={anchor} maxWidth={maxWidth}>
          {children}
        </FloatingCard>
      ) : null}
    </Modal>
  );
}

function FloatingCard({ anchor, maxWidth, children }: { anchor: Anchor | null; maxWidth: number; children: ReactNode }) {
  const { colors: c, reduceMotion } = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [cardH, setCardH] = useState(0);
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!cardH) return;
    if (reduceMotion) anim.setValue(1);
    else Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 7, tension: 140 }).start();
  }, [cardH, anim, reduceMotion]);

  const cardW = Math.min(maxWidth, W - space.gutter * 2);
  const top0 = insets.top + space.sm;
  const bottom0 = H - insets.bottom - space.sm;
  let left = (W - cardW) / 2;
  let top = (H - cardH) / 2;
  let below = true;
  let arrowX = 0;
  if (anchor) {
    const mid = anchor.x + anchor.width / 2;
    left = Math.max(space.gutter, Math.min(W - space.gutter - cardW, mid - cardW / 2));
    const roomBelow = bottom0 - (anchor.y + anchor.height);
    below = roomBelow >= cardH + ARROW + GAP || roomBelow >= anchor.y - top0;
    top = below ? anchor.y + anchor.height + ARROW + GAP : anchor.y - GAP - ARROW - cardH;
    top = Math.max(top0, Math.min(bottom0 - cardH, top));
    arrowX = Math.max(radius.lg, Math.min(cardW - radius.lg - ARROW * 2, mid - left - ARROW));
  }

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] });
  const shift = anim.interpolate({ inputRange: [0, 1], outputRange: [anchor ? (below ? -8 : 8) : 12, 0] });

  return (
    <Animated.View
      accessibilityViewIsModal
      onLayout={(e) => setCardH(Math.ceil(e.nativeEvent.layout.height))}
      style={[
        styles.card,
        {
          left,
          top,
          width: cardW,
          maxHeight: bottom0 - top0,
          backgroundColor: c.surface1,
          borderColor: c.border,
          opacity: cardH ? anim : 0,
          transform: [{ translateY: shift }, { scale }],
        },
      ]}
    >
      {anchor ? (
        <View
          pointerEvents="none"
          style={[
            styles.arrow,
            { left: arrowX, backgroundColor: c.surface1, borderColor: c.border },
            below ? { top: -ARROW + 1, borderLeftWidth: 1, borderTopWidth: 1 } : { bottom: -ARROW + 1, borderRightWidth: 1, borderBottomWidth: 1 },
          ]}
        />
      ) : null}
      {children}
    </Animated.View>
  );
}

/** What a popover says about one key term: a small lagoon label, the term, its definition, then any actions. */
export function TermCard({ term, label, children, actions, onClose }: { term: string; label?: string; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <View style={[styles.termIcon, { backgroundColor: `${c.lagoon}22` }]}>
          <Ionicons name="bookmark" size={14} color={c.lagoon} />
        </View>
        <Text variant="label" style={{ color: c.lagoon, flex: 1 }} numberOfLines={1}>
          {label ?? t('glossary.term_label')}
        </Text>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('global.close')} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <Ionicons name="close" size={20} color={c.textSecondary} />
        </Pressable>
      </View>
      <Text variant="title" accessibilityRole="header">
        {term}
      </Text>
      {children}
      {actions ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, marginTop: space.xs }}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  spot: { position: 'absolute', borderWidth: 1.5, borderRadius: radius.sm },
  card: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
  },
  arrow: { position: 'absolute', width: ARROW * 2, height: ARROW * 2, transform: [{ rotate: '45deg' }] },
  termIcon: { width: 24, height: 24, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
});
