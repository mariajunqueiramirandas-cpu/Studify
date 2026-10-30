import { useState } from 'react';
import { Button, PageChips, Popover, RichContent, TermCard, Text, useOverlay, type Anchor } from '../../components';
import { useSession } from '../auth/session';
import { useSubject } from '../subjects/api';
import { t } from '../../i18n';
import { createUserCard, type GlossaryTerm } from './api';
import { messageFor } from '../../api/messages';

/** S-MAT-13 {Termo}: definition, 📄, "Criar cartão" — floating next to the tapped word. */
export function TermSheet({
  term,
  visible,
  onClose,
  subjectId,
  nodeId,
  anchor = null,
}: {
  term: GlossaryTerm | null;
  visible: boolean;
  onClose: () => void;
  subjectId: string;
  nodeId?: string;
  anchor?: Anchor | null;
}) {
  const { userId } = useSession();
  const overlay = useOverlay();
  const subject = useSubject(subjectId);
  const [created, setCreated] = useState(false);
  const close = () => (setCreated(false), onClose());
  return (
    <Popover visible={visible && !!term} anchor={anchor} onClose={close}>
      {term ? (
        <TermCard
          term={term.term}
          onClose={close}
          actions={
            <>
              <PageChips sources={term.source_pages} subjectId={subjectId} max={2} />
              <Button
                compact
                variant="tonal"
                icon={created ? 'checkmark' : 'add'}
                label={created ? t('glossary.already_card') : t('glossary.create_card')}
                disabled={created}
                onPress={async () => {
                  try {
                    await createUserCard(userId!, { subjectId, nodeId: term.node_id ?? nodeId!, type: 'basic', front: term.term, back: term.definition, sourcePages: term.source_pages, shared: !!subject.data?.owner_class_group_id });
                    setCreated(true);
                    overlay.snack(t('cards.saved'));
                  } catch (e) {
                    overlay.snack(messageFor(e));
                  }
                }}
              />
            </>
          }
        >
          <RichContent variant="reading" text={term.definition} />
          {term.example ? (
            <Text variant="bodySmall" tone="secondary">
              {t('glossary.example')}: {term.example}
            </Text>
          ) : null}
        </TermCard>
      ) : null}
    </Popover>
  );
}
