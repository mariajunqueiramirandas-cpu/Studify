import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import type { TrailState } from '@studify/shared';
import { IconButton, ProgressBar, Text } from '../../components';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

type Segment = 'done' | 'shaky' | 'current' | 'todo';

/** One segment per concept of the chapter (per question in the chapter test), so every answer visibly moves it. */
function segmentsOf(state: TrailState): Segment[] {
  if (state.phase === 'checkpoint' && state.checkpoint?.total) {
    const { answered, total } = state.checkpoint;
    return Array.from({ length: total }, (_, i) => (i < answered ? 'done' : i === answered ? 'current' : 'todo'));
  }
  const chapter = state.chapters[state.chapter_index];
  if (!chapter || chapter.status === 'done' || state.phase === 'teach') return chapter ? chapter.concepts.map(() => 'done') : [];
  return chapter.concepts.map((c) => (c.state === 'cleared' ? 'done' : c.state === 'shaky' ? 'shaky' : c.state === 'current' ? 'current' : 'todo'));
}

/**
 * The Trilha's top: close, where you are (chapter and how far along the whole path), the map, and a bar made of the
 * chapter's concepts — green when understood, amber to revisit, the one you're on gently breathing.
 */
export function TrailHeader({ state, onMap }: { state: TrailState | null; onMap: () => void }) {
  const { colors: c } = useTheme();
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const chapter = state?.chapters[state.chapter_index];
  const segments = state ? segmentsOf(state) : [];
  const cleared = segments.filter((s) => s === 'done').length;
  const showChapter = !!chapter && state?.status !== 'completed';
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <IconButton icon="close" label={t('global.close')} onPress={close} />
        {state && showChapter ? (
          <Pressable onPress={onMap} accessibilityRole="button" accessibilityLabel={`${t('trail.chapter_label', { i: state.chapter_index + 1, n: state.chapters.length })}: ${chapter.title}. ${t('trail.plan_open')}`} style={styles.title}>
            <Text variant="label" tone="secondary" numberOfLines={1}>
              {t('trail.chapter_short', { i: state.chapter_index + 1, n: state.chapters.length })} · {t('trail.overall', { pct: Math.round(state.progress * 100) })}
            </Text>
            <Text variant="heading" numberOfLines={1}>
              {chapter.title}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.title} />
        )}
        {state ? <IconButton icon="map-outline" label={t('trail.plan_open')} onPress={onMap} filled /> : null}
      </View>
      {state ? (
        <View style={styles.bar}>
          {segments.length > 1 ? (
            <View
              style={styles.segments}
              accessibilityRole="progressbar"
              accessibilityLabel={t('trail.concepts_progress', { k: cleared, n: segments.length })}
              accessibilityValue={{ min: 0, max: segments.length, now: cleared }}
            >
              {segments.map((s, i) => (
                <SegmentView key={i} kind={s} track={c.surface2} color={s === 'done' ? c.success : s === 'shaky' ? c.warning : c.primary} />
              ))}
            </View>
          ) : (
            <ProgressBar value={state.progress} height={8} label={t('trail.title')} />
          )}
        </View>
      ) : null}
    </View>
  );
}

function SegmentView({ kind, color, track }: { kind: Segment; color: string; track: string }) {
  const { reduceMotion } = useTheme();
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (kind !== 'current' || reduceMotion) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 850, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [kind, pulse, reduceMotion]);
  return (
    <View style={[styles.segment, { backgroundColor: track }]}>
      {kind !== 'todo' ? <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, borderRadius: radius.xs, opacity: kind === 'current' ? pulse : 1 }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.xs, paddingBottom: space.md, gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: space.xs },
  title: { flex: 1, paddingHorizontal: space.xs },
  bar: { paddingHorizontal: space.gutter - space.xs },
  segments: { flexDirection: 'row', gap: space.xs },
  segment: { flex: 1, height: 8, borderRadius: radius.xs, overflow: 'hidden' },
});
