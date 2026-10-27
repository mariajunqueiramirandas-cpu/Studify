import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import type { Grade } from 'ts-fsrs';
import { ActionBar, Banner, BottomSheet, Button, EmptyState, Flashcard, IconButton, ListItem, PageChips, ProgressBar, RatingBar, Row, Screen, Text, useOverlay } from '../components';
import { useDb } from '../db/DatabaseProvider';
import { formatMinutes } from '../features/common/format';
import { buildLocalQueue, previewIntervals, type ReviewCard } from '../features/memory/local';
import { useStorageUrl } from '../features/subjects/api';
import { setCardFlag } from '../features/learn/api';
import { useSession } from '../features/auth/session';
import { useCardMnemonic } from '../features/mnemonics/api';
import { FlagSheet } from '../features/trust/FlagSheet';
import { options, t } from '../i18n';
import { useSessionStore } from '../stores/session';
import { space } from '../theme';
import { ReadAloudButton } from '../features/voice/VoiceButtons';
import { WellbeingNudge } from '../features/wellbeing/WellbeingNudge';

const LEECH_LAPSES = 6;

/** S-PRA-02 Revisão — FSRS session, fully offline (MEM-02, PLT-07, ADR 0007). Immersive. */
export default function Review() {
  const { subjectId, source } = useLocalSearchParams<{ subjectId?: string; source?: 'session' | 'vespera' }>();
  const db = useDb();
  const { userId } = useSession();
  const overlay = useOverlay();
  const store = useSessionStore();
  // WEL-03 performance drop: Errei counts as a miss.
  const sessionItems = useMemo(() => store.history.map((h) => ({ correct: h.rating > 1, ms: h.ms })), [store.history]);
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [flag, setFlag] = useState(false);
  const [leech, setLeech] = useState<ReviewCard | null>(null);
  // The card whose mnemonic hint was opened before the reveal (keyed by card, so it resets on the next one).
  const [hintFor, setHintFor] = useState<string | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    const q = buildLocalQueue(db, { subjectId });
    setQueue(q);
    store.start(q.map((c) => c.id));
    return () => store.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, subjectId]);

  const current = queue?.[store.index] ?? null;
  const mediaUrl = useStorageUrl(current?.media?.path);
  // MEM-06.4: the student's mnemonic, shown on the back and, before the reveal, behind "Ver dica".
  const mnemonic = useCardMnemonic(current?.id).data ?? null;
  const hint = current !== null && hintFor === current.id;
  const intervals = useMemo(() => (current ? previewIntervals(db, current.id) : undefined), [db, current]);
  const menuLabels = options('review.menu');

  useEffect(() => {
    shownAt.current = Date.now();
  }, [store.index]);

  const rate = async (rating: Grade) => {
    if (!current) return;
    const card = current;
    try {
      await store.answer(db, rating, { durationMs: Date.now() - shownAt.current, source: source ?? 'session', hintUsed: hint });
      overlay.undo(`${options('review.rating.again').length ? '' : ''}${[t('review.rating.again'), t('review.rating.hard'), t('review.rating.good'), t('review.rating.easy')][rating - 1]}`, () => void store.undo(db));
      // MEM-02.12 leech prompt on the lapse that marks it.
      if (rating === 1 && card.isLeech) setLeech(card);
    } catch {
      overlay.snack(t('error.generic'));
    }
  };

  const finished = queue && store.index >= queue.length;
  useEffect(() => {
    if (finished && queue.length) {
      const minutes = Math.max(1, Math.round((Date.now() - (store.startedAt ?? Date.now())) / 60000));
      void store.finish();
      router.replace({ pathname: '/session/end', params: { cards: String(store.history.length), minutes: String(minutes), kind: 'review' } });
    }
  }, [finished, queue, store]);

  if (queue && queue.length === 0) {
    return (
      <Screen title={t('review.title')} immersive>
        <EmptyState icon="checkmark-done-outline" title={t('review.all_done')} message={t('review.empty_body')} action={{ label: t('global.close'), onPress: () => router.back() }} />
      </Screen>
    );
  }

  const tags = current ? [...(current.isNew ? [t('review.tag.new')] : []), ...(current.examTag ? [t('review.tag.exam', { subject: current.examTag.subjectName, n: current.examTag.days })] : [])] : [];
  return (
    <Screen
      title={queue ? t('review.progress', { i: Math.min(store.index + 1, queue.length), n: queue.length }) : t('review.title')}
      immersive
      scroll={false}
      onBack={async () => {
        if (store.history.length === 0 || (await overlay.confirm({ title: t('global.leave_confirm_title'), message: t('global.leave_confirm_body'), confirmLabel: t('global.leave'), cancelLabel: t('global.stay') }))) {
          void store.finish();
          router.back();
        }
      }}
      actions={current ? <IconButton icon="ellipsis-horizontal" label={t('global.more_options')} onPress={() => setMenu(true)} /> : null}
      footer={
        current ? (
          <ActionBar>
            {store.revealed ? <RatingBar intervals={intervals} onRate={(r) => void rate(r as Grade)} /> : <Button label={t('review.reveal')} onPress={store.reveal} />}
          </ActionBar>
        ) : null
      }
    >
      {queue ? <ProgressBar value={queue.length ? store.index / queue.length : 0} /> : null}
      {queue && queue.length > 150 && store.index === 0 ? (
        <Banner kind="info" message={t('review.recovery', { n: queue.length, d: Math.ceil(queue.length / 100) })} />
      ) : null}
      <WellbeingNudge surface="review" sessionItems={sessionItems} />
      {current ? (
        <View style={{ flex: 1, gap: space.md, paddingVertical: space.md }}>
          <Flashcard
            key={current.id}
            front={current.front}
            back={current.back}
            type={current.type}
            clozeIndex={current.clozeIndex}
            media={current.media}
            mediaUri={mediaUrl.data ?? null}
            flipped={store.revealed}
            onFlip={store.reveal}
            tags={tags}
            footer={
              <Row>
                <View style={{ flex: 1 }}>
                  <PageChips sources={current.sourcePages} subjectId={current.subjectId} />
                </View>
                <ReadAloudButton id={`card:${current.id}`} text={store.revealed ? current.back : current.front} />
              </Row>
            }
          />
          {mnemonic && (store.revealed || hint) ? (
            <Banner kind="info" icon="bulb-outline" title={mnemonic.title} message={mnemonic.content.text} />
          ) : mnemonic ? (
            <Button compact variant="text" icon="bulb-outline" label={t('mnemonic.show_hint')} onPress={() => setHintFor(current.id)} />
          ) : null}
        </View>
      ) : null}
      <Text variant="bodySmall" tone="secondary" align="center">
        {queue ? `≈ ${formatMinutes(Math.max(1, Math.round(((queue.length - store.index) * 8) / 60)))}` : ''}
      </Text>

      <BottomSheet visible={menu} onClose={() => setMenu(false)}>
        <ListItem icon="create-outline" title={menuLabels[0] ?? 'Editar'} onPress={() => (setMenu(false), router.push({ pathname: '/subjects/[subjectId]/card/[cardId]', params: { subjectId: current!.subjectId, cardId: current!.id } }))} />
        <ListItem
          icon="pause-circle-outline"
          title={menuLabels[1] ?? 'Suspender'}
          onPress={async () => {
            setMenu(false);
            await setCardFlag(userId!, current!.id, { suspended: true }).catch(() => undefined);
            setQueue((q) => (q ? q.filter((c) => c.id !== current!.id) : q));
            overlay.snack(t('review.suspended'));
          }}
        />
        <ListItem
          icon="eye-off-outline"
          title={menuLabels[2] ?? 'Excluir pra mim'}
          onPress={async () => {
            setMenu(false);
            await setCardFlag(userId!, current!.id, { hidden: true }).catch(() => undefined);
            setQueue((q) => (q ? q.filter((c) => c.id !== current!.id) : q));
            overlay.snack(t('review.hidden'));
          }}
        />
        <ListItem icon="flag-outline" title={menuLabels[3] ?? t('global.report_error')} onPress={() => (setMenu(false), setFlag(true))} />
      </BottomSheet>
      {current ? <FlagSheet visible={flag} onClose={() => setFlag(false)} itemType="card" itemId={current.id} shared={false} /> : null}
      <BottomSheet visible={!!leech} onClose={() => setLeech(null)} title={t('review.leech')}>
        <Button variant="tonal" icon="bulb-outline" label={t('mnemonic.create')} onPress={() => (setLeech(null), router.push({ pathname: '/mnemonic/new', params: { cardId: leech!.id } }))} />
        <Button variant="tonal" label={options('review.leech_actions')[0] ?? 'Reescrever'} onPress={() => (setLeech(null), router.push({ pathname: '/subjects/[subjectId]/card/[cardId]', params: { subjectId: leech!.subjectId, cardId: leech!.id } }))} />
        <Button variant="text" label={options('review.leech_actions')[2] ?? 'Agora não'} onPress={() => setLeech(null)} />
      </BottomSheet>
    </Screen>
  );
}

export { LEECH_LAPSES };
