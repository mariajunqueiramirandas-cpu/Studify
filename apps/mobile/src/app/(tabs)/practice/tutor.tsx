import { Button, Card, EmptyState, ListItem, Screen, SkeletonList } from '../../../components';
import { relativeDay } from '../../../features/common/format';
import { useSubjects } from '../../../features/subjects/api';
import { useThreads } from '../../../features/tutor/api';
import { openThread, openTutor } from '../../../features/tutor/open';
import { t } from '../../../i18n';

/** S-TUT-01 Conversas — thread list with scope chips (TUT-01). */
export default function TutorThreads() {
  const threads = useThreads();
  const subjects = useSubjects();
  const name = new Map((subjects.data ?? []).map((s) => [s.id, s.name]));
  const first = subjects.data?.find((s) => !s.settings?.archived_at);
  return (
    <Screen title={t('tutor.threads')} onRefresh={threads.refetch} refreshing={threads.isRefetching}>
      {first ? <Button icon="add" label={t('tutor.new_thread')} onPress={() => openTutor({ type: 'subject', subject_id: first.id })} /> : null}
      {threads.isLoading ? <SkeletonList rows={5} height={56} /> : null}
      {threads.isFetched && !threads.data?.length ? <EmptyState icon="chatbubbles-outline" message={t('tutor.no_threads')} /> : null}
      {(threads.data ?? []).map((th) => (
        <Card key={th.id}>
          <ListItem
            icon="chatbubble-ellipses-outline"
            title={th.title ?? t('tutor.title')}
            subtitle={[th.subject_id ? name.get(th.subject_id) : null, th.last_message_at ? relativeDay(th.last_message_at) : null].filter(Boolean).join(' · ')}
            onPress={() => openThread(th.id)}
          />
        </Card>
      ))}
    </Screen>
  );
}
