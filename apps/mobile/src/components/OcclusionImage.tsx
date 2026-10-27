// Image-occlusion rendering (MEM-03.3, 03.5, 03.6): the image at its own aspect ratio with masks placed in
// normalized coordinates, so the card looks the same on any screen. Pinch to zoom, double tap to reset.
import { masksToRender, type OcclusionCardMedia, type OcclusionMask } from '@studify/shared';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { t } from '../i18n';
import { radius, useTheme } from '../theme';
import { Text } from './Text';

export function ZoomableView({ children }: { children: ReactNode }) {
  const scale = useSharedValue(1);
  const saved = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(4, Math.max(1, saved.value * e.scale));
    })
    .onEnd(() => {
      saved.value = scale.value;
    });
  const pan = Gesture.Pan()
    .minPointers(1)
    .onUpdate((e) => {
      if (scale.value > 1) {
        tx.value = e.translationX;
        ty.value = e.translationY;
      }
    });
  const reset = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1);
      saved.value = 1;
      tx.value = withTiming(0);
      ty.value = withTiming(0);
    });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, reset)}>
      <Animated.View style={[{ overflow: 'hidden' }, style]}>{children}</Animated.View>
    </GestureDetector>
  );
}

interface MaskBoxProps {
  mask: OcclusionMask;
  hidden: boolean;
  target: boolean;
  showLabel?: boolean;
  selected?: boolean;
  onPress?: () => void;
}

function MaskBox({ mask, hidden, target, showLabel, selected, onPress }: MaskBoxProps) {
  const { colors: c } = useTheme();
  const box = { left: `${mask.x * 100}%`, top: `${mask.y * 100}%`, width: `${mask.w * 100}%`, height: `${mask.h * 100}%` } as const;
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={target ? t('occlusion.asked_area') : mask.label || t('occlusion.mask')}
      style={[
        styles.mask,
        box,
        {
          backgroundColor: hidden ? (target ? c.warning : c.textSecondary) : 'transparent',
          borderColor: selected ? c.primary : target ? c.warning : c.border,
          borderWidth: selected || target ? 3 : 1,
        },
      ]}
    >
      {showLabel && !hidden && mask.label ? (
        <Text variant="caption" style={[styles.label, { backgroundColor: c.surface1 }]} numberOfLines={2}>
          {mask.label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One review face of an occlusion card. */
export function OcclusionCardImage({ media, uri, revealed }: { media: OcclusionCardMedia; uri: string | null; revealed: boolean }) {
  const { colors: c } = useTheme();
  return (
    <ZoomableView>
      <View style={{ width: '100%', aspectRatio: media.width / Math.max(1, media.height), backgroundColor: c.surface2, borderRadius: radius.md }}>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="fill" accessibilityLabel={t('occlusion.image')} /> : null}
        {masksToRender(media, revealed).map((m) => (
          <MaskBox key={m.mask.id} mask={m.mask} hidden={m.hidden} target={m.target} showLabel={revealed && m.target} />
        ))}
      </View>
    </ZoomableView>
  );
}

/** Editor surface: every mask visible with its label; tapping selects one. */
export function OcclusionEditorImage({ uri, width, height, masks, selectedId, onSelect, children }: { uri: string; width: number; height: number; masks: OcclusionMask[]; selectedId: string | null; onSelect: (id: string) => void; children?: ReactNode }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ width: '100%', aspectRatio: width / Math.max(1, height), backgroundColor: c.surface2, borderRadius: radius.md }}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="fill" accessibilityLabel={t('occlusion.image')} />
      {masks.map((m) => (
        <MaskBox key={m.id} mask={m} hidden={false} target={false} showLabel selected={m.id === selectedId} onPress={() => onSelect(m.id)} />
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  mask: { position: 'absolute', borderRadius: 4, justifyContent: 'center', overflow: 'hidden' },
  label: { paddingHorizontal: 2, alignSelf: 'center' },
});
