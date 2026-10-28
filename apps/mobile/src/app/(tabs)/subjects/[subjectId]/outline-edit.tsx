import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, BottomSheet, Button, ListItem, PageChips, RadioList, Screen, SkeletonList, Text, TextField, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { useSubject } from '../../../../features/subjects/api';
import { OutlineTree } from '../../../../features/subjects/OutlineTree';
import { editOutline, setNodeExcluded, undoOutlineEvent, useCanEditSubject, useInvalidateOutline, useOutline, type OutlineNode, type OutlineOp } from '../../../../features/subjects/outline';
import { t } from '../../../../i18n';
import { space } from '../../../../theme';
import { messageFor } from '../../../../api/messages';

/** Pages where a topic can be cut: every page after the first one it covers. */
function splitPages(n: OutlineNode): number[] {
  const pages = new Set<number>();
  for (const s of n.sources) for (let p = s.page_start + 1; p <= (s.page_end ?? s.page_start); p++) pages.add(p);
  return [...pages].sort((a, b) => a - b).slice(0, 60);
}

type Mode = { kind: 'menu' } | { kind: 'rename' } | { kind: 'merge' } | { kind: 'move' } | { kind: 'split' } | { kind: 'newUnit' };

/** S-MAT-06 Revisar mapa (ING-04): rename, merge, split, move, delete, "Não cai na prova". */
export default function OutlineEdit() {
  const { subjectId, fromUpload } = useLocalSearchParams<{ subjectId: string; fromUpload?: string }>();
  const { userId } = useSession();
  const subject = useSubject(subjectId);
  const outline = useOutline(subjectId);
  const canEdit = useCanEditSubject(subject.data);
  const invalidate = useInvalidateOutline(subjectId);
  const overlay = useOverlay();
  const [selected, setSelected] = useState<OutlineNode | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setMode(null);
    setSelected(null);
    setTarget(null);
    setText('');
  };

  const run = async (ops: OutlineOp[], doneKey: string) => {
    setBusy(true);
    try {
      const res = await editOutline(subjectId, ops);
      await invalidate();
      close();
      const eventId = res.event_ids[0];
      overlay.undo(t(doneKey), () => {
        if (eventId) void undoOutlineEvent(eventId).then(invalidate);
      });
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleExcluded = async (node: OutlineNode) => {
    close();
    await setNodeExcluded(userId!, node.id, !node.excluded);
    await invalidate();
    overlay.undo(node.excluded ? t('outline.include_again') : t('outline.excluded'), () => void setNodeExcluded(userId!, node.id, node.excluded).then(invalidate));
  };

  const siblings = (n: OutlineNode) => (outline.data ? [...outline.data.byId.values()].filter((x) => x.kind === n.kind && x.id !== n.id && !x.excluded) : []);
  const units = outline.data?.roots ?? [];

  return (
    <Screen
      title={t('outline.title')}
      footer={
        <ActionBar>
          <Button label={t('outline.looks_good')} onPress={() => router.replace(`/subjects/${subjectId}`)} />
          {canEdit ? <Button variant="text" icon="add" label={t('outline.new_unit')} onPress={() => setMode({ kind: 'newUnit' })} /> : null}
        </ActionBar>
      }
    >
      {fromUpload ? <Banner kind="success" message={t('ingest.outline_ready')} /> : null}
      {!canEdit && subject.data ? <Banner kind="neutral" icon="lock-closed-outline" message={t('outline.read_only')} /> : null}
      {outline.isLoading ? <SkeletonList rows={5} height={52} /> : null}
      {outline.data ? (
        <OutlineTree
          roots={outline.data.roots}
          depth={3}
          onPressNode={(n) => {
            setSelected(n);
            setMode({ kind: 'menu' });
          }}
          onLongPressNode={(n) => {
            setSelected(n);
            setMode({ kind: 'menu' });
          }}
        />
      ) : null}

      <BottomSheet visible={!!selected && mode?.kind === 'menu'} onClose={close} title={selected?.title}>
        {selected ? <PageChips sources={selected.sources} subjectId={subjectId} /> : null}
        {selected?.learning_objectives.length ? (
          <View style={{ gap: 4 }}>
            <Text variant="label">{t('topic.objectives')}</Text>
            {selected.learning_objectives.map((o) => (
              <Text key={o} variant="bodySmall">
                • {o}
              </Text>
            ))}
          </View>
        ) : null}
        {canEdit ? (
          <>
            <ListItem icon="create-outline" title={t('outline.rename_title')} onPress={() => (setText(selected?.title ?? ''), setMode({ kind: 'rename' }))} />
            {selected?.kind !== 'unit' ? <ListItem icon="git-merge-outline" title={t('outline.merge_title')} onPress={() => setMode({ kind: 'merge' })} /> : null}
            {selected?.kind === 'topic' && splitPages(selected).length > 0 ? <ListItem icon="cut-outline" title="Dividir aqui" onPress={() => setMode({ kind: 'split' })} /> : null}
            {selected?.kind === 'topic' ? <ListItem icon="return-down-forward-outline" title={t('outline.move_title')} onPress={() => setMode({ kind: 'move' })} /> : null}
            <ListItem
              icon="trash-outline"
              destructive
              title={t('global.delete')}
              onPress={async () => {
                const n = selected!;
                if (await overlay.confirm({ title: t('outline.delete_confirm', { title: n.title }), destructive: true, confirmLabel: t('global.delete') })) {
                  await run([{ op: 'delete', node_id: n.id }], 'outline.deleted');
                }
              }}
            />
          </>
        ) : null}
        {selected && selected.kind !== 'concept' ? (
          <ListItem icon={selected.excluded ? 'eye-outline' : 'eye-off-outline'} title={selected.excluded ? t('outline.include_again') : t('outline.excluded')} onPress={() => toggleExcluded(selected)} />
        ) : null}
      </BottomSheet>

      <BottomSheet
        visible={mode?.kind === 'rename' || mode?.kind === 'newUnit'}
        onClose={close}
        title={mode?.kind === 'newUnit' ? t('outline.new_unit') : t('outline.rename_title')}
        footer={
          <Button
            label={t('global.save')}
            loading={busy}
            disabled={!text.trim()}
            onPress={() =>
              mode?.kind === 'newUnit'
                ? run([{ op: 'create', kind: 'unit', title: text.trim(), parent_id: null }], 'global.done')
                : run([{ op: 'rename', node_id: selected!.id, title: text.trim() }], 'outline.renamed')
            }
          />
        }
      >
        <TextField label={mode?.kind === 'newUnit' ? t('outline.new_unit_name') : t('subjects.name')} value={text} onChangeText={setText} autoFocus maxLength={200} />
      </BottomSheet>

      <BottomSheet
        visible={mode?.kind === 'merge'}
        onClose={close}
        title={t('outline.merge_title')}
        footer={<Button label={t('global.confirm')} loading={busy} disabled={!target} onPress={() => run([{ op: 'merge', node_ids: [target!, selected!.id] }], 'outline.merged')} />}
      >
        {selected ? <RadioList value={target} onChange={setTarget} options={siblings(selected).map((n) => ({ value: n.id, label: n.title }))} /> : null}
      </BottomSheet>

      <BottomSheet
        visible={mode?.kind === 'move'}
        onClose={close}
        title={t('outline.move_title')}
        footer={<Button label={t('global.confirm')} loading={busy} disabled={!target} onPress={() => run([{ op: 'move', node_id: selected!.id, parent_id: target }], 'outline.moved')} />}
      >
        <RadioList value={target} onChange={setTarget} options={units.filter((u) => u.id !== selected?.parent_id).map((u) => ({ value: u.id, label: u.title }))} />
      </BottomSheet>

      <BottomSheet
        visible={mode?.kind === 'split'}
        onClose={close}
        title="Dividir aqui"
        footer={
          <Button
            label={t('global.confirm')}
            loading={busy}
            disabled={!target}
            onPress={() => run([{ op: 'split', node_id: selected!.id, page: Number(target), ...(text.trim() ? { title: text.trim() } : {}) }], 'outline.split_done')}
          />
        }
      >
        <Text tone="secondary" variant="bodySmall">
          O novo tópico começa na página escolhida.
        </Text>
        <TextField label={t('subjects.name')} value={text} onChangeText={setText} placeholder={selected ? `${selected.title} (parte 2)` : ''} />
        {selected ? <RadioList value={target} onChange={setTarget} options={splitPages(selected).map((p) => ({ value: String(p), label: `pág. ${p}` }))} /> : null}
      </BottomSheet>
      <View style={{ height: space.xl }} />
    </Screen>
  );
}
