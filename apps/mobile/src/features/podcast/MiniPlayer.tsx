// Mini-player (spec 12 §5.1): the episode keeps playing across the app; tap to open the player.
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconButton } from '../../components/Button';
import { Text } from '../../components/Text';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';
import { pause, play, stop, usePodcastPlayer } from './player';

export function MiniPlayer() {
  const { colors: c } = useTheme();
  const track = usePodcastPlayer((s) => s.track);
  const playing = usePodcastPlayer((s) => s.playing);
  const progress = usePodcastPlayer((s) => (s.track?.durationMs ? s.positionMs / s.track.durationMs : 0));
  if (!track) return null;
  return (
    <View style={[styles.wrap, { backgroundColor: c.surface1, borderTopColor: c.border }]}>
      <View style={[styles.progress, { width: `${Math.min(100, progress * 100)}%`, backgroundColor: c.primary }]} />
      <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel={`${t('podcast.open_player')}: ${track.title}`} onPress={() => router.push({ pathname: '/podcast/[podcastId]', params: { podcastId: track.episodeId } })}>
        <Ionicons name="headset-outline" size={22} color={c.primary} />
        <Text numberOfLines={1} style={{ flex: 1 }}>
          {track.title}
        </Text>
      </Pressable>
      <IconButton icon={playing ? 'pause' : 'play'} label={playing ? t('podcast.pause') : t('podcast.play')} onPress={() => (playing ? pause() : play())} />
      <IconButton icon="close" label={t('global.close')} onPress={stop} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingLeft: space.md },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52 },
  progress: { position: 'absolute', top: 0, left: 0, height: 2 },
});
