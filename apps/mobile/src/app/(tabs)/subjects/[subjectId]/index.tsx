import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  ProgressBar,
  Row,
  Screen,
  Section,
  SkeletonList,
  Text,
  useOverlay,
  type IconName,
} from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { colorKeyFromHex, setSubjectArchived, useDocuments, useSubject, useSubjectJobs, useSubjects } from '../../../../features/subjects/api';
import { OutlineTree } from '../../../../features/subjects/OutlineTree';
import { useCanEditSubject, useMastery, useOutline } from '../../../../features/subjects/outline';
import { ProcessingCard, ingestionJob } from '../../../../features/subjects/ProcessingCard';
import { openTutor } from '../../../../features/tutor/open';
import { t } from '../../../../i18n';
import { space, subjectColor, useTheme } from '../../../../theme';

/** S-MAT-03 {Matéria}: outline, materials, processing card, progress, shortcuts. */
export default function SubjectHome() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const { userId } = useSession();
  const subject = useSubject(subjectId);
  const subjects = useSubjects();
  const outline = useOutline(subjectId);
  const docs = useDocuments(subjectId);
  const jobs = useSubjectJobs(subjectId);
  const mastery = useMastery(subjectId);
  const canEdit = useCanEditSubject(subject.data);
  const overlay = useOverlay();
  const { scheme } = useTheme();
  const [menu, setMenu] = useState(false);

  const masteryMap = useMemo(() => new Map([...(mastery.data?.values() ?? [])].map((m) => [m.node_id, m.mastery])), [mastery.data]);
  const settings = subjects.data?.find((s) => s.id === subjectId)?.settings;
  const s = subject.data;
  const topics = outline.data?.topics.filter((tp) => !tp.excluded) ?? [];
  const studied = topics.filter((tp) => (masteryMap.get(tp.id) ?? 0) > 0).length;

  const refresh = () => {
    void subject.refetch();
    void outline.refetch();
    void docs.refetch();
    void jobs.refetch();
  };

  if (subject.isError) return <Screen title=""><ErrorState onRetry={refresh} /></Screen>;

  return (
    <Screen
      title=""
      onRefresh={refresh}
      refreshing={outline.isRefetching}
      actions={
        <>
          <IconButton icon="chatbubbles-outline" label={t('global.ask_tutor')} onPress={() => openTutor({ type: 'subject', subject_id: subjectId })} />
          <IconButton icon="ellipsis-vertical" label={t('global.more_options')} onPress={() => setMenu(true)} />
        </>
      }
    >
      {s ? <SubjectCover name={s.name} icon={s.icon} tint={subjectColor(colorKeyFromHex(s.color), scheme)} studied={studied} total={topics.length} dark={scheme === 'dark'} /> : null}

      <ProcessingCard subjectId={subjectId} job={ingestionJob(jobs.data)} documents={docs.data ?? []} />

      {outline.isLoading ? <SkeletonList rows={4} height={56} /> : null}
      {outline.data && outline.data.roots.length === 0 && !(docs.data ?? []).length ? (
        <EmptyState
          icon="cloud-upload-outline"
          title={t('subjects.no_material')}
          message={t('subjects.no_material_body')}
          action={{ label: t('upload.button'), icon: 'add', onPress: () => router.push(`/subjects/${subjectId}/upload`) }}
        />
      ) : null}

      {topics.length ? (
        <Row wrap>
          <Button compact variant="tonal" icon="flash-outline" label={t('review.start')} onPress={() => router.push({ pathname: '/review', params: { subjectId } })} />
          <Button compact variant="tonal" icon="help-circle-outline" label={t('subjects.practice')} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { subjectId } })} />
        </Row>
      ) : null}

      {outline.data && outline.data.roots.length ? (
        <Section
          title={t('subjects.outline')}
          action={canEdit || s?.owner_class_group_id ? <Button compact variant="text" icon="create-outline" label={t('outline.title')} onPress={() => router.push(`/subjects/${subjectId}/outline-edit`)} /> : null}
        >
          <OutlineTree roots={outline.data.roots} mastery={masteryMap} onPressNode={(n) => n.kind !== 'unit' && router.push(`/subjects/${subjectId}/topic/${n.id}`)} />
        </Section>
      ) : null}

      <Section title={t('subjects.shortcuts')}>
        <Card>
          <ListItem icon="map-outline" title={t('map.title')} subtitle={t('map.entry_hint')} onPress={() => router.push({ pathname: '/subjects/[subjectId]/map', params: { subjectId } })} />
          <ListItem icon="timer-outline" title={t('focus.title')} subtitle={t('focus.entry_hint')} onPress={() => router.push({ pathname: '/focus', params: { subjectId, ...(s?.name ? { label: s.name } : {}) } })} />
          <ListItem icon="document-text-outline" title={t('subjects.documents')} subtitle={docs.data ? `${docs.data.length}` : undefined} onPress={() => router.push(`/subjects/${subjectId}/documents`)} />
          <ListItem icon="albums-outline" title={t('subjects.cards')} onPress={() => router.push(`/subjects/${subjectId}/cards`)} />
          <ListItem icon="text-outline" title={t('subjects.glossary')} onPress={() => router.push(`/subjects/${subjectId}/glossary`)} />
          <ListItem icon="git-network-outline" title={t('subjects.concept_map')} onPress={() => router.push(`/subjects/${subjectId}/concept-map`)} />
          <ListItem icon="sparkles-outline" title={t('memory_map.title')} onPress={() => router.push({ pathname: '/practice/memory-map', params: { subjectId } })} />
          <ListItem icon="newspaper-outline" title={t('subjects.past_tests')} onPress={() => router.push(`/subjects/${subjectId}/past-tests`)} />
          <ListItem icon="headset-outline" title={t('podcast.episodes')} onPress={() => router.push({ pathname: '/podcast/list', params: { subjectId } })} />
          <ListItem icon="chatbubbles-outline" title={t('arg.title')} subtitle={t('arg.entry_hint')} onPress={() => router.push({ pathname: '/argument/new', params: { goalMode: 'exam_week', subjectId } })} />
          <ListItem icon="camera-outline" title={t('cam.title')} subtitle={t('cam.add_photos_hint')} onPress={() => router.push({ pathname: '/camera', params: { subjectId } })} />
        </Card>
      </Section>

      <Button icon="add" label={t('upload.button')} onPress={() => router.push(`/subjects/${subjectId}/upload`)} />

      <BottomSheet visible={menu} onClose={() => setMenu(false)} title={s?.name}>
        {s?.owner_profile_id === userId ? <ListItem icon="create-outline" title={t('subjects.edit')} onPress={() => (setMenu(false), router.push(`/subjects/${subjectId}/edit`))} /> : null}
        {s?.owner_profile_id === userId ? <ListItem icon="people-outline" title={t('subjects.share_with_class')} onPress={() => (setMenu(false), router.push({ pathname: '/class', params: { shareSubjectId: subjectId } }))} /> : null}
        <ListItem
          icon="archive-outline"
          title={settings?.archived_at ? t('subjects.unarchive') : t('subjects.archive')}
          onPress={async () => {
            setMenu(false);
            const archiving = !settings?.archived_at;
            if (archiving && !(await overlay.confirm({ title: t('subjects.archive_confirm', { name: s?.name ?? '' }) }))) return;
            await setSubjectArchived(userId!, subjectId, archiving);
            void subjects.refetch();
            if (archiving) router.back();
          }}
        />
      </BottomSheet>
    </Screen>
  );
}

/** The open notebook's cover: the subject's colour as a wash, its name set large, how much of it you've studied. */
function SubjectCover({ name, icon, tint, studied, total, dark }: { name: string; icon: string | null; tint: string; studied: number; total: number; dark: boolean }) {
  return (
    <View style={{ marginHorizontal: -(space.gutter), marginTop: -space.sm, paddingHorizontal: space.gutter, paddingVertical: space.lg, gap: space.md, backgroundColor: `${tint}${dark ? '2A' : '1C'}`, borderBottomWidth: 3, borderBottomColor: tint }}>
      <Ionicons name={(icon ?? 'book-outline') as IconName} size={30} color={tint} />
      <Text variant="display" accessibilityRole="header">
        {name}
      </Text>
      {total ? (
        <View style={{ gap: space.xs }}>
          <Text variant="bodySmall" tone="secondary">
            {t('subjects.progress', { done: studied, total })}
          </Text>
          <ProgressBar value={studied / total} color={tint} height={6} />
        </View>
      ) : null}
    </View>
  );
}
