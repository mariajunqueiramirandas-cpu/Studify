import { useState } from 'react';
import { BottomSheet, Button, PageChips, RichContent, Text, useOverlay } from '../../components';
import { useSession } from '../auth/session';
import { useSubject } from '../subjects/api';
import { t } from '../../i18n';
import { createUserCard, type GlossaryTerm } from './api';

/** S-MAT-13 {Termo}: definition, 📄, "Criar cartão". */
export function TermSheet({ term, visible, onClose, subjectId, nodeId }: { term: GlossaryTerm | null; visible: boolean; onClose: () => void; subjectId: string; nodeId?: string }) {
  const { userId } = useSession();
  const overlay = useOverlay();
  const subject = useSubject(subjectId);
  const [created, setCreated] = useState(false);
  return (
    <BottomSheet visible={visible && !!term} onClose={() => (setCreated(false), onClose())} title={term?.term}>
      {term ? (
        <>
          <RichContent text={term.definition} />
          {term.example ? (
            <Text variant="bodySmall" tone="secondary">
              {t('glossary.example')}: {term.example}
            </Text>
          ) : null}
          <PageChips sources={term.source_pages} subjectId={subjectId} />
          <Button
            variant="tonal"
            icon="add"
            label={created ? t('glossary.already_card') : t('glossary.create_card')}
            disabled={created}
            onPress={async () => {
              try {
                await createUserCard(userId!, { subjectId, nodeId: term.node_id ?? nodeId!, type: 'basic', front: term.term, back: term.definition, sourcePages: term.source_pages, shared: !!subject.data?.owner_class_group_id });
                setCreated(true);
                overlay.snack(t('cards.saved'));
              } catch {
                overlay.snack(t('error.generic'));
              }
            }}
          />
        </>
      ) : null}
    </BottomSheet>
  );
}

