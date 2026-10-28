// Touch feedback (ux §10): a light tick for taps, a firmer one for commits, a success buzz for wins. Off with
// Acessibilidade → "Vibrar ao tocar". Never awaited and never throws: a phone without a vibrator just stays quiet.
import * as Haptics from 'expo-haptics';
import { useUiStore } from '../stores/ui';

const on = () => useUiStore.getState().haptics;

export function tap(): void {
  if (on()) void Haptics.selectionAsync().catch(() => undefined);
}

export function thud(): void {
  if (on()) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

export function cheer(): void {
  if (on()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}
