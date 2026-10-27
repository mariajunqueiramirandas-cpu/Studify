import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { BottomSheet, Button, Card, EmptyState, ListItem, Screen, SkeletonList, Text, TextField, useOverlay } from '../../../../components';
import { formatBytes, shortDate } from '../../../../features/common/format';
import { deleteDocument, renameDocument, useDocuments, type DocumentRow } from '../../../../features/subjects/api';
import { downloadDocumentForOffline, isDocumentDownloaded } from '../../../../features/subjects/files';
import { options, t } from '../../../../i18n';

const KIND_INDEX: Record<string, number> = { slides: 0, notes: 1, textbook: 2, past_test: 3, content_list: 4 };

/** S-MAT-07 Documentos da matéria: status, rename, delete, offline download (ING-01, PLT-07). */
export default function Documents() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const docs = useDocuments(subjectId);
  const overlay = useOverlay();
  const [menu, setMenu] = useState<DocumentRow | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const kinds = options('upload.kinds');

  return (
    <Screen title={t('subjects.documents')} onRefresh={docs.refetch} refreshing={docs.isRefetching} footer={<Card><Button icon="add" label={t('upload.button')} onPress={() => router.push(`/subjects/${subjectId}/upload`)} /></Card>}>
      {docs.isLoading ? <SkeletonList rows={3} /> : null}
      {docs.data?.length === 0 ? <EmptyState message={t('subjects.no_material_body')} action={{ label: t('upload.button'), onPress: () => router.push(`/subjects/${subjectId}/upload`) }} /> : null}
      {(docs.data ?? []).map((d) => (
        <Card key={d.id}>
          <ListItem
            icon={d.status === 'failed' ? 'alert-circle-outline' : isDocumentDownloaded(d.id) ? 'cloud-done-outline' : 'document-text-outline'}
            title={d.title}
            subtitle={[d.kind in KIND_INDEX ? kinds[KIND_INDEX[d.kind]!] : null, d.page_count ? t('subjects.pages', { n: d.page_count }) : null, formatBytes(d.size_bytes), shortDate(d.created_at), d.status !== 'ready' ? t(`ingest.stages.${d.status === 'processing' ? 'extracting' : d.status}`) : null]
              .filter(Boolean)
              .join(' · ')}
            onPress={() => router.push({ pathname: '/subjects/[subjectId]/document/[documentId]', params: { subjectId, documentId: d.id, page: '1' } })}
            onLongPress={() => setMenu(d)}
            right={<Button compact variant="text" label="⋯" accessibilityLabel={t('global.more_options')} onPress={() => setMenu(d)} />}
            chevron={false}
          />
        </Card>
      ))}
      <BottomSheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.title}>
        <ListItem icon="warning-outline" title={t('findings.title')} subtitle={t('findings.menu_hint')} onPress={() => (setMenu(null), router.push({ pathname: '/subjects/[subjectId]/findings', params: { subjectId, documentId: menu!.id, title: menu!.title } }))} />
        <ListItem icon="create-outline" title={t('subjects.rename_document')} onPress={() => (setRenaming(menu!.title), null)} />
        <ListItem
          icon="cloud-download-outline"
          title={t('subjects.download_offline')}
          onPress={async () => {
            const d = menu!;
            setMenu(null);
            try {
              await downloadDocumentForOffline(d);
              overlay.snack(t('subjects.downloaded'));
            } catch {
              overlay.snack(t('error.network'));
            }
          }}
        />
        <ListItem
          icon="trash-outline"
          destructive
          title={t('subjects.delete_document')}
          onPress={async () => {
            const d = menu!;
            setMenu(null);
            if (await overlay.confirm({ title: t('subjects.delete_document_confirm', { name: d.title }), destructive: true, confirmLabel: t('global.delete') })) {
              await deleteDocument(d.id).catch(() => overlay.snack(t('error.permission')));
              void docs.refetch();
            }
          }}
        />
      </BottomSheet>
      <BottomSheet
        visible={renaming !== null}
        onClose={() => (setRenaming(null), setMenu(null))}
        title={t('subjects.rename_document')}
        footer={
          <Button
            label={t('global.save')}
            disabled={!renaming?.trim()}
            onPress={async () => {
              await renameDocument(menu!.id, renaming!).catch(() => overlay.snack(t('error.permission')));
              setRenaming(null);
              setMenu(null);
              void docs.refetch();
            }}
          />
        }
      >
        <TextField label={t('subjects.name')} value={renaming ?? ''} onChangeText={setRenaming} autoFocus />
      </BottomSheet>
      <Text variant="bodySmall" tone="secondary">
        {t('ingest.processing_title')}: {(docs.data ?? []).filter((d) => d.status === 'processing').length}
      </Text>
    </Screen>
  );
}
