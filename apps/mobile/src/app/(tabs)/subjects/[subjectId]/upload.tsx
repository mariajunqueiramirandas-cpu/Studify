import * as DocumentPicker from 'expo-document-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, ProgressBar, Row, Screen, Text, TextField, useOnline, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { formatBytes } from '../../../../features/common/format';
import { askNotificationsAfterUpload } from '../../../../features/profile/permissions';
import { UPLOAD_KINDS, uploadMaterial, useDocuments, useSubjectJobs, type DocumentKind } from '../../../../features/subjects/api';
import { useSharedFile, type SharedFile } from '../../../../features/subjects/share';
import { options, t } from '../../../../i18n';
import { space } from '../../../../theme';
import { messageFor } from '../../../../api/messages';

const ERROR_KEYS: Record<string, string> = {
  too_large: 'ingest.too_large',
  unsupported_type: 'upload.only_pdf',
  duplicate_document: 'ingest.duplicate',
  pdf_password_protected: 'ingest.password',
  password_protected: 'ingest.password',
  corrupt: 'ingest.corrupt',
  pdf_corrupt: 'ingest.corrupt',
  file_too_large: 'ingest.too_large',
  too_many_pages: 'ingest.too_many_pages',
  budget_exhausted: 'budget.upload_paused',
};

/** S-MAT-04 Adicionar material (ING-01): file picker (or a PDF shared from another app) + optional kind chip. */
export default function Upload() {
  const { subjectId, shared } = useLocalSearchParams<{ subjectId: string; shared?: string }>();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const docs = useDocuments(subjectId);
  const jobs = useSubjectJobs(subjectId);
  const [file, setFile] = useState<SharedFile | null>(() => (shared ? useSharedFile.getState().take() : null));
  const [kind, setKind] = useState<DocumentKind | null>(null);
  const [teacher, setTeacher] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; existingId?: string } | null>(null);
  const kindLabels = options('upload.kinds');

  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
    if (!res.canceled && res.assets[0]) {
      const a = res.assets[0];
      setFile({ uri: a.uri, name: a.name, size: a.size ?? 0, mimeType: a.mimeType ?? 'application/pdf' });
      setError(null);
    }
  };

  const send = async () => {
    if (!file || !userId) return;
    setPct(0);
    setError(null);
    try {
      const isFirst = (docs.data ?? []).length === 0;
      const out = await uploadMaterial({
        subjectId,
        uri: file.uri,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        kind: kind ?? 'other',
        teacherName: kind === 'past_test' ? teacher.trim() || null : null,
        onProgress: setPct,
      });
      if (!out.ok) {
        setPct(null);
        setError({ message: t(ERROR_KEYS[out.code] ?? 'ingest.failed'), existingId: out.existingDocumentId });
        return;
      }
      void docs.refetch();
      void jobs.refetch();
      await askNotificationsAfterUpload(overlay);
      router.replace({ pathname: '/subjects/[subjectId]/processing', params: { subjectId, firstUpload: isFirst ? '1' : '' } });
    } catch (e) {
      setPct(null);
      const key = ERROR_KEYS[(e as { code?: string }).code ?? ''];
      // The server's envelope message says what went wrong; the generic copy is the last resort.
      setError({ message: key ? t(key) : messageFor(e) });
    }
  };

  return (
    <Screen
      title={t('upload.button')}
      closeIcon
      footer={
        <ActionBar>
          {file ? (
            <Button label={t('upload.send')} icon="cloud-upload-outline" disabled={!online || pct !== null} disabledReason={t('offline.ai_disabled')} loading={pct !== null && pct >= 100} onPress={send} />
          ) : (
            <Button label={t('upload.pick')} icon="document-outline" onPress={pick} />
          )}
        </ActionBar>
      }
    >
      {!online ? <Banner kind="warning" message={t('offline.ai_disabled')} /> : null}
      {error ? (
        <Banner
          kind="danger"
          message={error.message}
          action={error.existingId ? { label: 'Abrir', onPress: () => router.replace({ pathname: '/subjects/[subjectId]/document/[documentId]', params: { subjectId, documentId: error.existingId!, page: '1' } }) } : undefined}
        />
      ) : null}
      {file ? (
        <Card>
          <Row>
            <View style={{ flex: 1 }}>
              <Text variant="label" numberOfLines={2}>
                {file.name}
              </Text>
              <Text variant="bodySmall" tone="secondary">
                {formatBytes(file.size)}
              </Text>
            </View>
            {pct === null ? <Button compact variant="text" label={t('global.edit')} onPress={pick} /> : null}
          </Row>
          {pct !== null ? (
            <View style={{ gap: space.xs }}>
              <ProgressBar value={pct / 100} label={t('upload.progress', { pct: Math.round(pct) })} />
              <Text variant="bodySmall" tone="secondary">
                {t('upload.progress', { pct: Math.round(pct) })}
              </Text>
            </View>
          ) : null}
        </Card>
      ) : null}
      <Text variant="label">{t('upload.kind_title')}</Text>
      <ChipGroup>
        {UPLOAD_KINDS.map((k, i) => (
          <Chip key={k} label={kindLabels[i] ?? k} selected={kind === k} onPress={() => setKind(kind === k ? null : k)} />
        ))}
      </ChipGroup>
      {kind === 'past_test' ? <TextField label={t('past_tests.teacher')} value={teacher} onChangeText={setTeacher} placeholder="Ex.: Prof. Ana" /> : null}
    </Screen>
  );
}
