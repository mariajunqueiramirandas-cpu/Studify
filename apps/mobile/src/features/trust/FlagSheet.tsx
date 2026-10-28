import { useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { BottomSheet, Button, RadioList, TextField, useOverlay } from '../../components';
import { options, t } from '../../i18n';
import { messageFor } from '../../api/messages';

export type FlagItemType = 'note' | 'card' | 'question' | 'glossary_term' | 'knowledge_node' | 'feed_item' | 'explanation' | 'tutor_message' | 'document';

// UI reasons (copy §4.11) → content_flags.reason (data-model §5.7). Typos have no own code: sent as
// `other` with a comment prefix so triage still sees it.
const REASONS = ['wrong_fact', 'wrong_answer', 'unclear', 'wrong_page', 'typo', 'inappropriate', 'other'] as const;
const DB_REASON: Record<(typeof REASONS)[number], string> = { wrong_fact: 'wrong_fact', wrong_answer: 'wrong_answer', unclear: 'unclear', wrong_page: 'wrong_page', typo: 'other', inappropriate: 'inappropriate', other: 'other' };

interface Props {
  visible: boolean;
  onClose: () => void;
  itemType: FlagItemType;
  itemId: string;
  shared: boolean;
  onFlagged?: (res: { hidden_for_you: boolean }) => void;
}

/** S-SYS-03 Reportar erro (TRU-02). Triage runs async; the item may be hidden for the reporter. */
export function FlagSheet({ visible, onClose, itemType, itemId, shared, onFlagged }: Props) {
  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const overlay = useOverlay();
  const labels = options('flag.reasons');
  const send = async () => {
    if (!reason) return;
    setBusy(true);
    try {
      const res = await callFunction<Record<string, unknown>, { flag_id: string; hidden_for_you: boolean }>(
        'flag-create',
        { item_type: itemType, item_id: itemId, reason: DB_REASON[reason], comment: (reason === 'typo' ? `[digitação] ${comment}` : comment).trim() || undefined },
        { idempotencyKey: uuidv7() },
      );
      overlay.snack(shared ? t('flag.thanks.shared') : t('flag.thanks.personal'));
      onFlagged?.(res);
      setReason(null);
      setComment('');
      onClose();
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('flag.title')} footer={<Button label={t('flag.send')} disabled={!reason} loading={busy} onPress={send} />}>
      <RadioList value={reason} onChange={setReason} options={REASONS.map((r, i) => ({ value: r, label: labels[i] ?? r }))} />
      <TextField label={t('flag.comment')} value={comment} onChangeText={setComment} multiline maxLength={500} />
    </BottomSheet>
  );
}
