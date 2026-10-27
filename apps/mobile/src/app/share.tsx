import { router } from 'expo-router';
import { View } from 'react-native';
import { Button, Card, EmptyState, Row, Screen, SkeletonList, SubjectBadge, Text } from '../components';
import { formatBytes } from '../features/common/format';
import { useSharedFile } from '../features/subjects/share';
import { colorKeyFromHex, useSubjects } from '../features/subjects/api';
import { t } from '../i18n';
import { subjectColor, useTheme } from '../theme';

/** S-MAT-04 share-intent: "Salvar em qual matéria?" — then the regular upload sheet with the file filled in. */
export default function ShareTarget() {
  const file = useSharedFile((s) => s.file);
  const subjects = useSubjects();
  const { scheme } = useTheme();
  const active = (subjects.data ?? []).filter((s) => !s.settings?.archived_at);

  const close = () => {
    useSharedFile.getState().set(null);
    router.canGoBack() ? router.back() : router.replace('/today');
  };

  if (!file) {
    return (
      <Screen title={t('upload.share_sheet')} closeIcon onBack={close}>
        <EmptyState icon="document-outline" message={t('upload.only_pdf')} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('upload.share_sheet')}
      closeIcon
      onBack={close}
      footer={<Button variant="secondary" icon="add" label={t('subjects.new')} onPress={() => router.replace({ pathname: '/subjects/new', params: { then: 'upload' } })} />}
    >
      <Text tone="secondary" numberOfLines={2}>
        {t('upload.picked', { name: file.name, size: formatBytes(file.size) })}
      </Text>
      {subjects.isLoading ? <SkeletonList rows={3} height={64} /> : null}
      {active.map((s) => (
        <Card
          key={s.id}
          accent={subjectColor(colorKeyFromHex(s.color), scheme)}
          accessibilityLabel={s.name}
          onPress={() => router.replace({ pathname: '/subjects/[subjectId]/upload', params: { subjectId: s.id, shared: '1' } })}
        >
          <Row gap={12}>
            <SubjectBadge color={colorKeyFromHex(s.color)} icon={s.icon} />
            <View style={{ flex: 1 }}>
              <Text variant="heading" numberOfLines={2}>
                {s.name}
              </Text>
            </View>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
