import type { PodcastStyle } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { data } from '../../api/data';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, Screen, SegmentedControl, SkeletonList, Text, useOnline, useOverlay } from '../../components';
import { createEpisode } from '../../features/podcast/api';
import { useSubject } from '../../features/subjects/api';
import { useOutline } from '../../features/subjects/outline';
import { options, t } from '../../i18n';
import { space } from '../../theme';

const STYLES: PodcastStyle[] = ['overview', 'deep', 'exam_review'];

/**
 * S-INT-01 Podcast setup (INT-01.1–01.2, 01.6): topics, duration (5 / 10 / 15 min, data-model §5.8) and style.
 * A Turma episode that already exists is offered at once, at no cost.
 */
export default function NewPodcast() {
  const params = useLocalSearchParams<{ subjectId: string; nodeIds?: string; examId?: string; style?: PodcastStyle }>();
  const online = useOnline();
  const overlay = useOverlay();
  const subject = useSubject(params.subjectId);
  const outline = useOutline(params.subjectId);
  const initial = useMemo(() => new Set((params.nodeIds ?? '').split(',').filter(Boolean)), [params.nodeIds]);
  const [picked, setPicked] = useState<Set<string>>(initial);
  // "Ouvir revisão desta prova" (INT-01.1): the exam's scope topics are preselected.
  useEffect(() => {
    if (!params.examId || initial.size) return;
    void data<{ node_ids: string[] }>('podcast-data-exam-scope', { exam_id: params.examId })
      .then((res) => setPicked(new Set(res.node_ids)))
      .catch(() => undefined);
  }, [params.examId, initial.size]);
  const [length, setLength] = useState<'5' | '10' | '15'>('10');
  const [style, setStyle] = useState<PodcastStyle>(params.style ?? (params.examId ? 'exam_review' : 'overview'));
  const [busy, setBusy] = useState(false);
  const styleLabels = options('podcast.styles');
  const topics = (outline.data?.topics ?? []).filter((n) => !n.excluded && n.content_status === 'ready');

  const generate = async () => {
    setBusy(true);
    try {
      const res = await createEpisode({ subject_id: params.subjectId, node_ids: [...picked].slice(0, 30), style, length_minutes: Number(length) as 5 | 10 | 15, ...(params.examId ? { exam_id: params.examId } : {}) });
      if (res.dropped_topics.length) overlay.snack(t('podcast.dropped', { list: res.dropped_topics.join(', ') }));
      if (res.cached && !(await overlay.confirm({ title: t('podcast.title'), message: t('podcast.cached'), confirmLabel: t('podcast.listen_now') }))) return;
      router.replace({ pathname: '/podcast/[podcastId]', params: { podcastId: res.episode_id } });
    } catch (e) {
      const code = (e as { code?: string }).code;
      overlay.snack(code === 'rate_limited' ? t('podcast.too_many') : code === 'budget_exhausted' ? t('budget.user_daily') : t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('podcast.title')}
      closeIcon
      onBack={() => router.back()}
      footer={
        <ActionBar>
          <Button label={t('podcast.generate')} icon="mic-outline" loading={busy} disabled={!online || picked.size === 0} disabledReason={online ? undefined : t('offline.ai_disabled')} onPress={() => void generate()} />
        </ActionBar>
      }
    >
      <Text tone="secondary">{subject.data?.name ?? ''}</Text>
      <Text variant="label">{t('podcast.topics')}</Text>
      {outline.isLoading ? (
        <SkeletonList rows={2} height={40} />
      ) : topics.length ? (
        <ChipGroup>
          {topics.map((n) => (
            <Chip
              key={n.id}
              label={n.title}
              selected={picked.has(n.id)}
              onPress={() =>
                setPicked((s) => {
                  const next = new Set(s);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                })
              }
            />
          ))}
        </ChipGroup>
      ) : (
        <Banner kind="neutral" message={t('podcast.no_topics')} />
      )}
      {topics.length > 1 ? <Button compact variant="text" label={picked.size === topics.length ? t('podcast.clear_all') : t('podcast.pick_all')} onPress={() => setPicked(picked.size === topics.length ? new Set() : new Set(topics.map((n) => n.id)))} /> : null}
      <SegmentedControl<'5' | '10' | '15'>
        label={t('podcast.duration')}
        value={length}
        onChange={setLength}
        options={(['5', '10', '15'] as const).map((v) => ({ value: v, label: t('global.minutes_short', { n: v }) }))}
      />
      <Text variant="label">{t('podcast.style')}</Text>
      {STYLES.map((s, i) => (
        <Card key={s} tone={style === s ? 'soft' : 'outline'} onPress={() => setStyle(s)} accessibilityLabel={styleLabels[i]}>
          <Text variant="heading">{styleLabels[i] ?? s}</Text>
          <Text variant="bodySmall" tone="secondary">{t(`podcast.style_hint.${s}`)}</Text>
        </Card>
      ))}
      <Text variant="bodySmall" tone="secondary" style={{ marginBottom: space.lg }}>
        {t('podcast.hosts')}
      </Text>
    </Screen>
  );
}
