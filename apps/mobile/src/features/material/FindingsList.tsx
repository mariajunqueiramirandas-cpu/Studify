// "Avisos do material" (ING-06.2–06.5): possible errors with page chips and a suggested fix, "Não é erro" /
// "É erro mesmo", low severity behind a toggle. A confirmed finding on a topic offers "Refazer conteúdo".
import { visibleFindings } from '@studify/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, PageChips, Pill, Row, SwitchRow, Text, useOverlay } from '../../components';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';
import { useFindings, useMyFindingVotes, voteFinding, type FindingRow } from './api';
import { messageFor } from '../../api/messages';

export function FindingsList({ documentId, nodeId, subjectId, onRedo }: { documentId?: string; nodeId?: string; subjectId: string; onRedo?: () => void }) {
  const findings = useFindings({ documentId, nodeId });
  const all = findings.data ?? [];
  const votes = useMyFindingVotes(all.map((f) => f.id));
  const [showLow, setShowLow] = useState(false);
  const overlay = useOverlay();
  const { colors: c } = useTheme();
  const myVotes = votes.data ?? new Map<string, 'is_error' | 'not_error'>();
  const shown = visibleFindings(all, { showLow, myVotes });
  const hiddenLow = all.filter((f) => f.severity === 'low').length;
  if (all.length === 0) return null;

  const vote = (f: FindingRow, v: 'is_error' | 'not_error') =>
    void voteFinding(f.id, v)
      .then(() => Promise.all([findings.refetch(), votes.refetch()]))
      .then(() => overlay.snack(v === 'is_error' ? t('findings.confirmed_snack') : t('findings.dismissed_snack')))
      .catch((e: unknown) => overlay.snack(messageFor(e)));

  return (
    <View style={{ gap: space.sm }}>
      {shown.map((f) => (
        <Card key={f.id} tone="outline">
          <Row>
            <Pill icon="warning-outline" text={f.status === 'confirmed' ? t('findings.confirmed') : t('findings.possible')} color={f.status === 'confirmed' ? c.danger : c.warning} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              {t(`findings.type.${f.type}`)}
            </Text>
          </Row>
          <Text variant="bodySmall">{f.description}</Text>
          {f.suggested_fix ? (
            <Text variant="bodySmall" tone="success">
              {t('findings.fix')}: {f.suggested_fix}
            </Text>
          ) : null}
          <PageChips
            sources={[
              { document_id: f.document_id, page_start: f.page_start, page_end: f.page_end },
              ...(f.related_page ? [{ document_id: f.related_document_id ?? f.document_id, page_start: f.related_page, page_end: f.related_page }] : []),
            ]}
            subjectId={subjectId}
          />
          {f.confirmations > 0 ? (
            <Text variant="caption" tone="secondary">
              {t('findings.confirmations', { n: f.confirmations })}
            </Text>
          ) : null}
          <Row wrap>
            <Button compact variant="text" label={t('findings.not_error')} onPress={() => vote(f, 'not_error')} />
            <Button compact variant={myVotes.get(f.id) === 'is_error' ? 'tonal' : 'text'} label={t('findings.is_error')} onPress={() => vote(f, 'is_error')} />
            {f.status === 'confirmed' && onRedo ? <Button compact variant="text" icon="refresh" label={t('findings.redo')} onPress={onRedo} /> : null}
          </Row>
        </Card>
      ))}
      {hiddenLow > 0 ? <SwitchRow label={t('findings.show_low', { n: hiddenLow })} value={showLow} onChange={setShowLow} /> : null}
    </View>
  );
}

/** ⚠️ on a topic: how many visible findings point at it. */
export function useTopicFindingCount(nodeId: string): number {
  const findings = useFindings({ nodeId });
  return (findings.data ?? []).filter((f) => f.status !== 'dismissed' && f.severity !== 'low').length;
}
