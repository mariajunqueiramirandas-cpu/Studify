import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../../../api/functions';
import { uploadFile } from '../../../../api/storage';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, RadioList, Row, Screen, Section, Text, TextField, useOnline, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { confirmScope, recomputePlan, resolveScope, useExam, useInvalidateGoal, useScope, type ScopeResolveRes } from '../../../../features/goals/api';
import { useOutline } from '../../../../features/subjects/outline';
import { t } from '../../../../i18n';
import { space, useTheme } from '../../../../theme';
import { messageFor } from '../../../../api/messages';

type Mode = 'input' | 'pick' | 'review';

/** S-OBJ-06 O que vai cair? + S-OBJ-07 Revisar conteúdo ✅ 🟡 ❌ (GOL-03). */
export default function ScopeScreen() {
  const { goalId, examId } = useLocalSearchParams<{ goalId: string; examId: string }>();
  const { userId } = useSession();
  const exam = useExam(examId);
  const outline = useOutline(exam.data?.subject_id ?? undefined);
  const existing = useScope(examId);
  const online = useOnline();
  const overlay = useOverlay();
  const invalidate = useInvalidateGoal();
  const { colors } = useTheme();
  const [mode, setMode] = useState<Mode>('input');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScopeResolveRes | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [partialPick, setPartialPick] = useState<Record<string, string>>({});
  const topics = useMemo(() => outline.data?.topics ?? [], [outline.data]);
  const title = (id: string) => outline.data?.byId.get(id)?.title ?? '…';

  const applyResult = (res: ScopeResolveRes) => {
    setResult(res);
    const ids = new Set<string>();
    for (const item of res.items) if (item.status === 'matched') item.nodes.forEach((n) => ids.add(n.node_id));
    setChosen(ids);
    setMode('review');
  };

  const resolveText = async () => {
    setBusy(true);
    try {
      applyResult(await resolveScope({ exam_id: examId, text }));
    } catch {
      overlay.snack(t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  const resolvePhoto = async (camera: boolean) => {
    const res = camera
      ? await ImagePicker.launchCameraAsync({ quality: 0.8, mediaTypes: ['images'] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ['images'] });
    if (res.canceled || !res.assets[0] || !exam.data?.subject_id) return;
    setBusy(true);
    try {
      const captureId = uuidv7();
      const path = `${userId}/${captureId}/1.jpg`;
      await uploadFile({ bucket: 'photos', path, uri: res.assets[0].uri, contentType: 'image/jpeg' });
      const doc = await callFunction<{ subject_id: string; image_paths: string[]; kind: string }, { document_id: string }>('upload-photos', { subject_id: exam.data.subject_id, image_paths: [path], kind: 'content_list' }, { idempotencyKey: captureId });
      applyResult(await resolveScope({ exam_id: examId, document_id: doc.document_id }));
    } catch {
      overlay.snack(t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (defaultAll = false) => {
    setBusy(true);
    try {
      const ids = new Set(chosen);
      Object.values(partialPick).forEach((id) => ids.add(id));
      await confirmScope(examId, defaultAll ? [] : [...ids], defaultAll);
      void recomputePlan('scope_changed', goalId).catch(() => undefined);
      invalidate(goalId);
      overlay.snack(t('scope.saved'));
      router.back();
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const matched = result?.items.filter((i) => i.status === 'matched') ?? [];
  const partial = result?.items.filter((i) => i.status === 'partial') ?? [];
  const unmatched = result?.items.filter((i) => i.status === 'unmatched') ?? [];

  return (
    <Screen
      title={mode === 'review' ? t('scope.review_title') : t('scope.title')}
      footer={
        <ActionBar>
          {mode === 'input' ? (
            <>
              <Button label={t('scope.resolve')} loading={busy} disabled={!text.trim() || !online} disabledReason={t('offline.ai_disabled')} onPress={resolveText} />
              <Button variant="text" label={t('global.skip_for_now')} onPress={() => save(true)} />
            </>
          ) : (
            <Button label={t('global.save')} loading={busy} disabled={!chosen.size && !Object.keys(partialPick).length} onPress={() => save(false)} />
          )}
        </ActionBar>
      }
    >
      {mode !== 'review' ? (
        <ChipGroup>
          <Chip label={t('scope.type')} selected={mode === 'input'} onPress={() => setMode('input')} />
          <Chip label={t('scope.pick')} selected={mode === 'pick'} onPress={() => (setMode('pick'), setChosen(new Set((existing.data?.nodes ?? []).filter((n) => n.confirmed).map((n) => n.node_id))))} />
        </ChipGroup>
      ) : null}
      {mode === 'input' ? (
        <>
          <Text tone="secondary">{t('scope.hint')}</Text>
          <Row wrap>
            <Button compact variant="tonal" icon="camera-outline" label={t('scope.photo')} disabled={!online || busy} onPress={() => resolvePhoto(true)} />
            <Button compact variant="tonal" icon="images-outline" label={t('scope.gallery')} disabled={!online || busy} onPress={() => resolvePhoto(false)} />
            <Button compact variant="tonal" icon="clipboard-outline" label={t('scope.paste')} onPress={async () => setText(await Clipboard.getStringAsync())} />
          </Row>
          <TextField value={text} onChangeText={setText} multiline placeholder={t('scope.text_placeholder')} accessibilityLabel={t('scope.title')} />
          {busy ? <Text tone="secondary">{t('scope.resolving')}</Text> : null}
        </>
      ) : null}
      {mode === 'pick' ? (
        <>
          {topics.map((tp) => (
            <Chip key={tp.id} label={tp.title} selected={chosen.has(tp.id)} onPress={() => setChosen((s) => { const n = new Set(s); if (n.has(tp.id)) n.delete(tp.id); else n.add(tp.id); return n; })} />
          ))}
        </>
      ) : null}
      {mode === 'review' && result ? (
        <>
          <Banner kind="info" message={t('scope.result', { matched: matched.length, total: result.items.length })} />
          {matched.length ? (
            <Section title={`✅ ${t('scope.matched')}`} action={<Button compact variant="text" label={t('scope.accept_all')} onPress={() => setChosen(new Set(matched.flatMap((m) => m.nodes.map((n) => n.node_id))))} />}>
              {matched.map((item) => (
                <Card key={item.id}>
                  <Text variant="label">{item.raw_text}</Text>
                  {item.nodes.map((n) => {
                    const node = outline.data?.byId.get(n.node_id);
                    return (
                      <View key={n.node_id} style={{ gap: 2 }}>
                        <Chip label={title(n.node_id)} selected={chosen.has(n.node_id)} onPress={() => setChosen((s) => { const x = new Set(s); if (x.has(n.node_id)) x.delete(n.node_id); else x.add(n.node_id); return x; })} />
                        {node?.excluded ? <Text variant="bodySmall" tone="warning">{t('scope.excluded_warning')}</Text> : null}
                      </View>
                    );
                  })}
                </Card>
              ))}
            </Section>
          ) : null}
          {partial.length ? (
            <Section title={`🟡 ${t('scope.partial')}`}>
              {partial.map((item) => (
                <Card key={item.id}>
                  <Text variant="label">{item.raw_text}</Text>
                  <RadioList value={partialPick[item.id] ?? null} onChange={(v) => setPartialPick((p) => ({ ...p, [item.id]: v }))} options={item.nodes.map((n) => ({ value: n.node_id, label: title(n.node_id) }))} />
                </Card>
              ))}
            </Section>
          ) : null}
          {unmatched.length ? (
            <Section title={`❌ ${t('scope.missing')}`}>
              <Banner kind="warning" message={t('scope.unmatched', { items: unmatched.map((u) => u.raw_text).join(', ') })} />
              {unmatched.map((item) => (
                <Card key={item.id} style={{ borderColor: colors.border }}>
                  <Text>{item.raw_text}</Text>
                  <Text variant="bodySmall" tone="secondary">
                    {item.placeholder_node_id ? t('scope.keep_placeholder') : t('scope.remove')}
                  </Text>
                </Card>
              ))}
              {exam.data?.subject_id ? <Button variant="text" icon="cloud-upload-outline" label={t('material.upload')} onPress={() => router.push(`/subjects/${exam.data!.subject_id}/upload`)} /> : null}
            </Section>
          ) : null}
          <View style={{ height: space.lg }} />
        </>
      ) : null}
    </Screen>
  );
}
