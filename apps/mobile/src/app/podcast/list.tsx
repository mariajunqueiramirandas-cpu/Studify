import { router, useLocalSearchParams } from 'expo-router';
import { Button, EmptyState, ListItem, Screen, SkeletonList } from '../../components';
import { formatMinutes } from '../../features/common/format';
import { useSubjectEpisodes } from '../../features/podcast/api';
import { useSubject } from '../../features/subjects/api';
import { options, t } from '../../i18n';

const STYLE_INDEX = { overview: 0, deep: 1, exam_review: 2 } as const;

/** Episodes of a subject (INT-01.1, 01.6): the Turma's shared ones and the student's own Revisão pra prova. */
export default function PodcastList() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const subject = useSubject(subjectId);
  const episodes = useSubjectEpisodes(subjectId);
  const styleLabels = options('podcast.styles');
  return (
    <Screen title={t('podcast.episodes')} onRefresh={() => void episodes.refetch()} refreshing={episodes.isRefetching}>
      <Button label={t('podcast.generate')} icon="mic-outline" onPress={() => router.push({ pathname: '/podcast/new', params: { subjectId } })} />
      {episodes.isLoading ? (
        <SkeletonList rows={3} />
      ) : episodes.data?.length ? (
        episodes.data.map((e) => (
          <ListItem
            key={e.id}
            icon={e.status === 'ready' ? 'headset-outline' : 'hourglass-outline'}
            title={e.title ?? subject.data?.name ?? t('podcast.title')}
            subtitle={[styleLabels[STYLE_INDEX[e.style]], e.duration_ms ? formatMinutes(Math.max(1, Math.round(e.duration_ms / 60000))) : t('global.minutes_short', { n: e.length_minutes }), e.status === 'ready' ? null : t(`podcast.stage.${e.status}`)].filter(Boolean).join(' · ')}
            onPress={() => router.push({ pathname: '/podcast/[podcastId]', params: { podcastId: e.id } })}
          />
        ))
      ) : (
        <EmptyState icon="headset-outline" message={t('podcast.none')} />
      )}
    </Screen>
  );
}
