import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { AiBadge, Button, ErrorState, MarkdownView, PageChips, Row, Screen, Skeleton, useOnline, useOverlay } from '../../../../../components';
import { requestNote, useNote } from '../../../../../features/learn/api';
import { ExplainSheet } from '../../../../../features/learn/ExplainSheet';
import { useNode } from '../../../../../features/subjects/outline';
import { FlagSheet } from '../../../../../features/trust/FlagSheet';
import { t } from '../../../../../i18n';

/** S-MAT-10 Resumo — full-screen reader (LRN-01). Depth switching lives on the topic screen. */
export default function NoteReader() {
  const { subjectId, noteId } = useLocalSearchParams<{ subjectId: string; noteId: string }>();
  const note = useNote(noteId);
  const { node } = useNode(subjectId, note.data?.node_id ?? undefined);
  const online = useOnline();
  const overlay = useOverlay();
  const [explain, setExplain] = useState(false);
  const [flag, setFlag] = useState(false);

  if (note.isError) return <Screen title=""><ErrorState onRetry={note.refetch} /></Screen>;
  const n = note.data;
  return (
    <Screen title={node?.title ?? t('topic.tabs').split(' · ')[0]}>
      {!n ? <Skeleton height={300} /> : null}
      {n ? (
        <>
          <MarkdownView
            markdown={n.body}
            terms={node?.key_terms}
            onCitation={(i) => {
              const c = n.citations[i];
              if (c) router.push({ pathname: '/subjects/[subjectId]/document/[documentId]', params: { subjectId, documentId: c.document_id, page: String(c.page_start), ...(c.cited_text ? { cite: c.cited_text.slice(0, 300) } : {}) } });
            }}
          />
          <PageChips sources={n.citations} subjectId={subjectId} max={6} />
          <AiBadge />
          <Row wrap>
            <Button compact variant="tonal" label={t('notes.explain')} disabled={!online} onPress={() => setExplain(true)} />
            <Button
              compact
              variant="text"
              label={t('notes.regenerate')}
              disabled={!online || !n.node_id}
              onPress={async () => {
                if (!(await overlay.confirm({ title: t('notes.regenerate_confirm') }))) return;
                try {
                  await requestNote(n.node_id!, n.depth, true);
                  void note.refetch();
                } catch (e) {
                  overlay.snack((e as { code?: string }).code === 'regenerate_limit' ? t('regenerate.limit') : t('error.generation'));
                }
              }}
            />
            <Button compact variant="text" label={t('global.report_error')} onPress={() => setFlag(true)} />
          </Row>
          <ExplainSheet visible={explain} onClose={() => setExplain(false)} target={n.node_id ? { target_type: 'concept', target_id: n.node_id } : null} subjectId={subjectId} />
          <FlagSheet visible={flag} onClose={() => setFlag(false)} itemType="note" itemId={n.id} shared={false} />
        </>
      ) : null}
    </Screen>
  );
}
