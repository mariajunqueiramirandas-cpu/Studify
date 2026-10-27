import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Flashcard, ListItem, PageChips, RadioList, Screen, SegmentedControl, Text, TextField, useOverlay } from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { createUserCard, saveCardEdit, setCardFlag, useSubjectCards, type CardRow } from '../../../../../features/learn/api';
import { useOutline } from '../../../../../features/subjects/outline';
import { FlagSheet } from '../../../../../features/trust/FlagSheet';
import { options, t } from '../../../../../i18n';
import { space } from '../../../../../theme';

type CardType = 'basic' | 'cloze' | 'reverse';
const TYPES: CardType[] = ['basic', 'cloze', 'reverse'];

/** S-MAT-16 Editar cartão: front/back with Markdown + math preview, type, source (MEM-01). */
export default function CardEditor() {
  const { subjectId, cardId, nodeId: nodeParam, shared } = useLocalSearchParams<{ subjectId: string; cardId: string; nodeId?: string; shared?: string }>();
  const isNew = cardId === 'new';
  const { userId } = useSession();
  const cards = useSubjectCards(subjectId);
  const outline = useOutline(subjectId);
  const overlay = useOverlay();
  const card = cards.data?.find((c) => c.id === cardId);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [type, setType] = useState<CardType>('basic');
  const [nodeId, setNodeId] = useState<string | null>(nodeParam ?? null);
  const [preview, setPreview] = useState(false);
  const [flag, setFlag] = useState(false);
  const [busy, setBusy] = useState(false);
  const typeLabels = options('cards.types');

  useEffect(() => {
    if (card) {
      setFront(card.front);
      setBack(card.back);
      setType(card.type === 'image_occlusion' ? 'basic' : card.type);
      setNodeId(card.node_id);
    }
  }, [card]);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        await createUserCard(userId!, { subjectId, nodeId: nodeId!, type, front, back, shared: !!shared });
      } else if (card) {
        const meaningChanged = card.back.trim() !== back.trim() && card.origin === 'user';
        if (meaningChanged && !(await overlay.confirm({ title: 'Mudou o sentido do cartão? (o progresso dele recomeça)' }))) {
          setBusy(false);
          return;
        }
        const res = await saveCardEdit(userId!, card as CardRow, front, back);
        if (res === 'override') overlay.snack(t('review.edit_shared'));
      }
      void cards.refetch();
      router.back();
    } catch {
      overlay.snack(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={isNew ? t('cards.new') : t('cards.edit')}
      footer={
        <ActionBar>
          <Button label={t('global.save')} loading={busy} disabled={!front.trim() || (!back.trim() && type !== 'cloze') || !nodeId} onPress={save} />
        </ActionBar>
      }
    >
      {card?.personal_for_user_id ? <Banner kind="neutral" message={t('cards.personal_note')} /> : null}
      <SegmentedControl<CardType> label={t('cards.type')} value={type} onChange={setType} options={TYPES.map((v, i) => ({ value: v, label: typeLabels[i] ?? v }))} />
      <TextField label={t('cards.front')} value={front} onChangeText={setFront} multiline hint={type === 'cloze' ? t('cards.cloze_hint') : undefined} />
      <TextField label={t('cards.back')} value={back} onChangeText={setBack} multiline />
      {isNew && !nodeParam ? (
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('outline.topic')}</Text>
          <RadioList value={nodeId} onChange={setNodeId} options={(outline.data?.topics ?? []).map((n) => ({ value: n.id, label: n.title }))} />
        </View>
      ) : null}
      <Button variant="text" label={t('cards.preview')} icon="eye-outline" onPress={() => setPreview((p) => !p)} />
      {preview ? (
        <View style={{ height: 360 }}>
          <Flashcard front={front} back={back} type={type} flipped={false} onFlip={() => undefined} />
        </View>
      ) : null}
      {card?.source_pages.length ? <PageChips sources={card.source_pages} subjectId={subjectId} /> : null}
      {!isNew && card ? (
        <Card>
          <ListItem icon="pause-circle-outline" title="Suspender" onPress={async () => (await setCardFlag(userId!, card.id, { suspended: true }), overlay.snack(t('review.suspended')), router.back())} />
          <ListItem icon="eye-off-outline" title="Excluir pra mim" onPress={async () => (await setCardFlag(userId!, card.id, { hidden: true }), overlay.snack(t('review.hidden')), router.back())} />
          <ListItem icon="flag-outline" title="Achou um erro nesse cartão? ⚑ Reportar erro" onPress={() => setFlag(true)} />
        </Card>
      ) : null}
      {card ? <FlagSheet visible={flag} onClose={() => setFlag(false)} itemType="card" itemId={card.id} shared={!!shared} /> : null}
    </Screen>
  );
}
