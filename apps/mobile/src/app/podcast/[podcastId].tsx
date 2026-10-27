import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppBar, Banner, Button, Card, Chip, ChipGroup, ErrorState, IconButton, PageChips, ProgressBar, Row, SkeletonList, SubjectBadge, Text, useOverlay } from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { useSession } from '../../features/auth/session';
import { formatClock } from '../../features/common/format';
import { downloadEpisode, downloadedFile, playableUri, removeDownload, resumePosition, useEpisode, useInteractions } from '../../features/podcast/api';
import { HandSheet } from '../../features/podcast/HandSheet';
import { PODCAST_RATES, loadTrack, pause, play, seek, setRate, skip, usePodcastPlayer } from '../../features/podcast/player';
import { episodeSources, flattenTimeline, lineAt, thinkCountdown } from '../../features/podcast/timeline';
import { useSubject } from '../../features/subjects/api';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

/**
 * S-INT-02 Player (INT-01.7–01.12): plays the episode (cloud voices, or the device voice when the episode has no
 * audio), speed, ±15 s, chapters, synced transcript (tap a line to seek), "Pausa pra pensar" countdown, Fontes,
 * offline download and the ✋ button. Playback continues in the background and in the mini-player.
 */
export default function PodcastPlayer() {
  const { podcastId } = useLocalSearchParams<{ podcastId: string }>();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const overlay = useOverlay();
  const db = useDb();
  const { userId } = useSession();
  const episode = useEpisode(podcastId);
  const subject = useSubject(episode.data?.subject_id);
  const interactions = useInteractions(podcastId);
  const player = usePodcastPlayer();
  const [hand, setHand] = useState(false);
  const [handKey, setHandKey] = useState(0);
  const [downloaded, setDownloaded] = useState(() => !!downloadedFile(podcastId));
  const [downloading, setDownloading] = useState(false);
  const e = episode.data;
  const script = e?.script;
  const timings = e?.line_timings;
  const lines = useMemo(() => (script ? flattenTimeline(script, timings) : []), [script, timings]);
  const ready = e?.status === 'ready' && !!e.script;
  const mine = player.track?.episodeId === podcastId;

  useEffect(() => {
    if (!ready || !e || !userId || mine) return;
    void (async () => {
      const [uri, start] = await Promise.all([playableUri(e), resumePosition(userId, e.id).catch(() => 0)]);
      await loadTrack(
        { episodeId: e.id, title: e.title ?? t('podcast.title'), artist: subject.data?.name ?? 'Studify', uri, lines, durationMs: e.duration_ms ?? lines[lines.length - 1]?.endMs ?? 0 },
        { startMs: start, database: db },
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, e?.id, userId]);

  if (episode.isError) return <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: c.bg }}><ErrorState onRetry={episode.refetch} /></View>;

  const position = mine ? player.positionMs : 0;
  const duration = e?.duration_ms ?? lines[lines.length - 1]?.endMs ?? 0;
  const current = lineAt(lines, position);
  const think = mine ? thinkCountdown(lines, position) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <AppBar
        title={t('podcast.title')}
        onBack={() => router.back()}
        actions={
          ready && e?.audio_path ? (
            <IconButton
              icon={downloaded ? 'cloud-done-outline' : 'cloud-download-outline'}
              label={downloaded ? t('podcast.remove_download') : t('podcast.download')}
              onPress={async () => {
                if (!e) return;
                if (downloaded) {
                  removeDownload(e.id);
                  setDownloaded(false);
                  return;
                }
                setDownloading(true);
                try {
                  await downloadEpisode(e);
                  setDownloaded(true);
                  overlay.snack(t('podcast.downloaded'));
                } catch {
                  overlay.snack(t('error.generic'));
                } finally {
                  setDownloading(false);
                }
              }}
            />
          ) : null
        }
      />
      {!e ? (
        <SkeletonList rows={3} />
      ) : e.status === 'failed' ? (
        <View style={{ padding: space.lg, gap: space.md }}>
          <Banner kind="danger" message={t('podcast.failed')} action={{ label: t('global.retry'), onPress: () => router.replace({ pathname: '/podcast/new', params: { subjectId: e.subject_id, nodeIds: e.node_ids.join(','), style: e.style } }) }} />
        </View>
      ) : !ready ? (
        <View style={{ padding: space.lg, gap: space.md }}>
          <Card>
            <Text variant="heading">{t('podcast.recording')}</Text>
            <ProgressBar value={e.status === 'queued' ? 0.1 : e.status === 'scripting' ? 0.4 : 0.8} label={t(`podcast.stage.${e.status}`)} />
          </Card>
          <Button variant="text" label={t('global.back')} onPress={() => router.back()} />
        </View>
      ) : (
        <>
          <FlatList
            data={lines}
            keyExtractor={(l) => String(l.index)}
            contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: 220 }}
            ListHeaderComponent={
              <View style={{ gap: space.md, marginBottom: space.md }}>
                <Row>
                  <SubjectBadge color={subject.data?.color} icon={subject.data?.icon} size={56} />
                  <View style={{ flex: 1 }}>
                    <Text variant="title" numberOfLines={2}>
                      {e.title}
                    </Text>
                    <Text variant="bodySmall" tone="secondary">
                      {t('podcast.hosts_line')}
                      {e.audio_path ? '' : ` · ${t('podcast.device_voice')}`}
                    </Text>
                  </View>
                </Row>
                {e.superseded_by ? <Banner kind="info" message={t('podcast.new_version')} action={{ label: t('podcast.open_new'), onPress: () => router.replace({ pathname: '/podcast/[podcastId]', params: { podcastId: e.superseded_by! } }) }} /> : null}
                {e.chapters?.length ? (
                  <ChipGroup>
                    {e.chapters.map((ch) => (
                      <Chip key={ch.segment_id} label={ch.title} selected={lines[current]?.segmentId === ch.segment_id} onPress={() => void seek(ch.start_ms)} />
                    ))}
                  </ChipGroup>
                ) : null}
                <Text variant="label">{t('podcast.transcript')}</Text>
              </View>
            }
            renderItem={({ item }) => (
              <Pressable onPress={() => void seek(item.startMs)} accessibilityRole="button" accessibilityLabel={`${item.speaker === 'bia' ? 'Bia' : 'Caio'}: ${item.text}`}>
                <View style={[styles.line, { backgroundColor: item.index === current && mine ? c.primarySoft : 'transparent' }]}>
                  <Text variant="label" tone={item.speaker === 'bia' ? 'accent' : 'info'}>
                    {item.speaker === 'bia' ? 'Bia' : 'Caio'}
                  </Text>
                  <Text>{item.text}</Text>
                </View>
              </Pressable>
            )}
            ListFooterComponent={
              <View style={{ gap: space.md, marginTop: space.lg }}>
                {interactions.data?.length ? (
                  <View style={{ gap: space.sm }}>
                    <Text variant="label">{t('podcast.your_questions')}</Text>
                    {interactions.data.map((q) => (
                      <Card key={q.id} tone="soft">
                        <Text variant="label">{t('podcast.your_question')}: {q.question_text}</Text>
                        {q.answer_lines.map((l, i) => (
                          <Text key={i} variant="bodySmall">
                            {l.speaker === 'bia' ? 'Bia' : 'Caio'}: {l.text}
                          </Text>
                        ))}
                        <PageChips sources={q.citations} subjectId={e.subject_id} />
                      </Card>
                    ))}
                  </View>
                ) : null}
                <Text variant="label">{t('podcast.sources')}</Text>
                <PageChips sources={e.script ? episodeSources(e.script) : []} subjectId={e.subject_id} max={12} />
              </View>
            }
          />
          <View style={[styles.controls, { backgroundColor: c.surface1, borderTopColor: c.border, paddingBottom: insets.bottom + space.md }]}>
            {think !== null ? (
              <Row>
                <Chip icon="hourglass-outline" label={t('podcast.pause_think', { s: think })} />
                <Button compact variant="text" label={t('global.skip_for_now')} onPress={() => void seek(lines[current]!.endMs)} />
              </Row>
            ) : null}
            <ProgressBar value={duration ? position / duration : 0} />
            <Row>
              <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                {formatClock(Math.round(position / 1000))}
              </Text>
              <Text variant="caption" tone="secondary">
                {formatClock(Math.round(duration / 1000))}
              </Text>
            </Row>
            <Row style={{ justifyContent: 'center', alignItems: 'center' }}>
              <Chip
                label={`${String(player.rate).replace('.', ',')}×`}
                accessibilityLabel={t('podcast.speed')}
                onPress={() => setRate(PODCAST_RATES[(PODCAST_RATES.indexOf(player.rate as (typeof PODCAST_RATES)[number]) + 1) % PODCAST_RATES.length]!)}
              />
              <IconButton icon="play-back-outline" label={t('podcast.back15')} onPress={() => skip(-15_000)} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={mine && player.playing ? t('podcast.pause') : t('podcast.play')}
                onPress={() => (mine && player.playing ? pause() : play())}
                style={[styles.play, { backgroundColor: c.primary }]}
              >
                <Ionicons name={mine && player.playing ? 'pause' : 'play'} size={32} color={c.onPrimary} />
              </Pressable>
              <IconButton icon="play-forward-outline" label={t('podcast.fwd15')} onPress={() => skip(15_000)} />
              <Button compact label={t('podcast.ask')} onPress={() => (setHandKey((k) => k + 1), setHand(true))} disabled={!mine || downloading} />
            </Row>
          </View>
          <HandSheet key={handKey} visible={hand} onClose={() => setHand(false)} episodeId={e.id} subjectId={e.subject_id} onAnswered={() => void interactions.refetch()} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { borderRadius: radius.md, padding: space.sm, gap: 2 },
  controls: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm },
  play: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
});
