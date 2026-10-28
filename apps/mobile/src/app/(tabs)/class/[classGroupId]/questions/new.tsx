import type { PeerQuestionCreateRes } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, AiBadge, Banner, Button, Card, Chip, ChipGroup, ListItem, RadioList, Row, Screen, SegmentedControl, SwitchRow, Text, TextField, useOnline, useOverlay } from '../../../../../components';
import { useClassSubjects } from '../../../../../features/class/api';
import { createPeerQuestion, useSubjectTopics } from '../../../../../features/class/turma5';
import { t } from '../../../../../i18n';
import { space } from '../../../../../theme';
import { messageFor } from '../../../../../api/messages';

type QType = 'mcq_single' | 'true_false' | 'short_answer';
const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

/** SOC-07.1–07.4: write a question for a topic, check it against the material (suggestions), then send it. */
export default function NewPeerQuestion() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const subjects = useClassSubjects(classGroupId);
  const online = useOnline();
  const overlay = useOverlay();
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const topics = useSubjectTopics(subjectId ?? undefined);
  const [qtype, setQtype] = useState<QType>('mcq_single');
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState<string[]>(['', '', '', '', '']);
  const [correct, setCorrect] = useState<string>('A');
  const [tfCorrect, setTfCorrect] = useState(true);
  const [answer, setAnswer] = useState('');
  const [explanation, setExplanation] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [check, setCheck] = useState<PeerQuestionCreateRes | null>(null);
  const [busy, setBusy] = useState<'check' | 'send' | null>(null);

  const payload = (): Record<string, unknown> => {
    const why = explanation.trim() || t('peer.default_explanation');
    if (qtype === 'mcq_single') {
      const filled = options.map((text, i) => ({ id: LETTERS[i]!, text: text.trim() })).filter((o) => o.text);
      return { options: filled.map((o) => ({ ...o, rationale: o.id === correct ? why : t('peer.wrong_rationale') })), correct };
    }
    if (qtype === 'true_false') return { statement: stem.trim(), correct: tfCorrect, justification: why };
    return { model_answer: answer.trim(), rubric: [{ id: 'r1', criterion: answer.trim(), points: 1 }], max_points: 1, key_terms: [] };
  };
  const ready = !!subjectId && !!nodeId && stem.trim().length >= 5 && (qtype !== 'mcq_single' || options.filter((o) => o.trim()).length >= 4) && (qtype !== 'short_answer' || answer.trim().length > 0);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'send');
    try {
      const res = await createPeerQuestion({ subject_id: subjectId!, node_id: nodeId!, type: qtype, stem: stem.trim(), payload: payload(), explanation: explanation.trim() || undefined, anonymous, dry_run: dryRun });
      setCheck(res);
      if (res.status === 'pending') {
        overlay.snack(t('peer.sent'));
        router.back();
      }
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const applyFix = () => {
    const fix = check?.validation.suggested_fix;
    if (!fix) return;
    setStem(fix.stem);
    const p = fix.payload as { options?: Array<{ id: string; text: string }>; correct?: unknown; model_answer?: string };
    if (qtype === 'mcq_single' && p.options) {
      setOptions(LETTERS.map((l) => p.options!.find((o) => o.id === l)?.text ?? ''));
      if (typeof p.correct === 'string') setCorrect(p.correct);
    }
    if (qtype === 'true_false' && typeof p.correct === 'boolean') setTfCorrect(p.correct);
    if (qtype === 'short_answer' && p.model_answer) setAnswer(p.model_answer);
    if (fix.explanation) setExplanation(fix.explanation);
    setCheck(null);
  };

  return (
    <Screen
      title={t('peer.new')}
      onBack={() => router.back()}
      footer={
        <ActionBar>
          <Button label={t('peer.send')} loading={busy === 'send'} disabled={!online || !ready} onPress={() => void run(false)} />
          <Button variant="text" label={t('peer.check')} loading={busy === 'check'} disabled={!online || !ready} onPress={() => void run(true)} />
        </ActionBar>
      }
    >
      <Text variant="label">{t('divide.subject')}</Text>
      <ChipGroup>
        {(subjects.data ?? []).map((s) => (
          <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => (setSubjectId(s.id), setNodeId(null))} />
        ))}
      </ChipGroup>
      {subjectId ? (
        <View style={{ maxHeight: 220 }}>
          {(topics.data ?? []).slice(0, 40).map((tp) => (
            <ListItem key={tp.id} icon={nodeId === tp.id ? 'radio-button-on' : 'radio-button-off'} title={tp.title} onPress={() => setNodeId(tp.id)} />
          ))}
        </View>
      ) : null}
      <SegmentedControl<QType> value={qtype} onChange={setQtype} options={(['mcq_single', 'true_false', 'short_answer'] as const).map((k) => ({ value: k, label: t(`peer.types.${k}`) }))} />
      <TextField label={qtype === 'true_false' ? t('peer.statement') : t('peer.stem')} value={stem} onChangeText={setStem} multiline maxLength={2000} />
      {qtype === 'mcq_single' ? (
        <View style={{ gap: space.xs }}>
          {LETTERS.map((l, i) => (
            <TextField key={l} label={`${l})`} value={options[i] ?? ''} onChangeText={(v) => setOptions((o) => o.map((x, j) => (j === i ? v : x)))} maxLength={500} />
          ))}
          <RadioList value={correct} onChange={setCorrect} options={LETTERS.filter((_, i) => (options[i] ?? '').trim()).map((l) => ({ value: l, label: t('peer.correct_is', { l }) }))} />
        </View>
      ) : null}
      {qtype === 'true_false' ? <SegmentedControl value={tfCorrect ? 'v' : 'f'} onChange={(v) => setTfCorrect(v === 'v')} options={[{ value: 'v', label: t('peer.true') }, { value: 'f', label: t('peer.false') }]} /> : null}
      {qtype === 'short_answer' ? <TextField label={t('peer.model_answer')} value={answer} onChangeText={setAnswer} multiline maxLength={1000} /> : null}
      <TextField label={t('peer.explanation')} value={explanation} onChangeText={setExplanation} multiline maxLength={2000} />
      <SwitchRow label={t('peer.anonymous_toggle')} value={anonymous} onChange={setAnonymous} />
      <Text variant="caption" tone="secondary">
        {t('peer.limit')}
      </Text>
      {check ? (
        <Card tone="soft">
          <Row>
            <Text variant="heading" style={{ flex: 1 }}>
              {check.blocking.length ? t('peer.needs_changes') : t('peer.looks_good')}
            </Text>
            <AiBadge />
          </Row>
          {check.blocking.map((b) => (
            <Banner key={b} kind="warning" message={t(`peer.blocking.${b}`)} />
          ))}
          {check.validation.clarity_issues.map((c) => (
            <Text key={c} variant="bodySmall">
              • {c}
            </Text>
          ))}
          {check.validation.suggested_fix ? <Button variant="tonal" label={t('peer.apply_fix')} onPress={applyFix} /> : null}
        </Card>
      ) : null}
    </Screen>
  );
}
