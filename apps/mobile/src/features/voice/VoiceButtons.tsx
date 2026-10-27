// Voice controls shared by the tutor, Lucas, the podcast ✋ sheet and written answers (WEL-04.8–04.9).
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconButton } from '../../components/Button';
import { Text } from '../../components/Text';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
import { useReadAloud, useVoiceInput, type VoiceError } from './voice';

export function voiceErrorText(error: VoiceError): string {
  return t(`voice.error_${error}`);
}

/**
 * "Segure pra falar": hold to listen, release to stop. The recognized text goes to `onText` for editing before
 * sending (WEL-04.9); the live transcript shows under the button while the student speaks.
 */
export function MicButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const { colors: c } = useTheme();
  const voice = useVoiceInput(onText);
  return (
    <View style={{ alignItems: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={voice.listening ? t('voice.listening') : t('voice.hold_to_talk')}
        accessibilityState={{ disabled: !!disabled, busy: voice.listening }}
        disabled={disabled}
        onPressIn={() => void voice.start()}
        onPressOut={voice.stop}
        style={[styles.mic, { backgroundColor: voice.listening ? c.danger : c.surface2 }]}
      >
        <Ionicons name={voice.listening ? 'mic' : 'mic-outline'} size={22} color={voice.listening ? c.onPrimary : c.textPrimary} />
      </Pressable>
      {voice.partial ? (
        <Text variant="caption" tone="secondary" numberOfLines={2} style={styles.partial}>
          {voice.partial}
        </Text>
      ) : null}
      {voice.error ? (
        <Text variant="caption" tone="warning" style={styles.partial}>
          {voiceErrorText(voice.error)}
        </Text>
      ) : null}
    </View>
  );
}

/** "Ouvir": reads a Markdown text aloud with the pt-BR voice; tap again to stop. */
export function ReadAloudButton({ id, text, size = 22 }: { id: string; text: string; size?: number }) {
  const { speaking, toggle } = useReadAloud(id);
  return <IconButton icon={speaking ? 'stop-circle-outline' : 'volume-high-outline'} label={speaking ? t('voice.stop_reading') : t('voice.read_aloud')} size={size} onPress={() => toggle(text)} />;
}

const styles = StyleSheet.create({
  mic: { width: 48, height: 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  partial: { maxWidth: 220, marginTop: space.xs },
});
