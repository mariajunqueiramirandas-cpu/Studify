import type { TeachingFinishRes } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppBar, Banner, Button, Card, PageChips, ProgressBar, ProgressRing, Row, Screen, SegmentedControl, Text, useOnline, useOverlay } from '../../components';
import type { StreamHandle } from '../../api/functions';
import { useSession } from '../../features/auth/session';
import { createUserCard } from '../../features/learn/api';
import { finishLesson, sendToLucas, startLesson, type LessonLength } from '../../features/lucas/api';
import { useNode } from '../../features/subjects/outline';
import { MicButton, ReadAloudButton } from '../../features/voice/VoiceButtons';
import { appendTranscript } from '../../features/voice/speech-text';
import { readAloud, stopReading } from '../../features/voice/voice';
import { options, t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
import { messageFor } from '../../api/messages';

interface Msg {
  id: string;
  role: 'student' | 'lucas';
  text: string;
  support?: boolean;
}

const BANDS = ['confused', 'almost', 'good', 'born_teacher'] as const;

/**
 * S-INT-03 Ensine o Lucas (INT-02): choose Rápido (6 turns) or Completo (12), explain by text or voice, Lucas asks
 * and sometimes believes something wrong; "Terminar aula" any time. Results: score, band, rubric, gaps and what
 * Lucas learned wrong with 📄 pages, cards from the weak points, and a retry with new misconceptions.
 */
export default function TeachLucas() {
  const { nodeId, subjectId } = useLocalSearchParams<{ nodeId: string; subjectId: string }>();
  const insets = useSafeAreaInsets();
  const { colors: c, type } = useTheme();
  const online = useOnline();
  const overlay = useOverlay();
  const { userId } = useSession();
  const node = useNode(subjectId, nodeId);
  const [length, setLength] = useState<LessonLength>('short');
  const [session, setSession] = useState<{ id: string; turnLimit: number } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [turn, setTurn] = useState(0);
  const [input, setInput] = useState('');
  const [spoken, setSpoken] = useState(false);
  const [readReplies, setReadReplies] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeachingFinishRes | null>(null);
  const handle = useRef<StreamHandle | null>(null);
  const list = useRef<FlatList<Msg>>(null);
  const seq = useRef(0);
  const lengthLabels = options('lucas.lengths');

  useEffect(() => () => (handle.current?.cancel(), stopReading()), []);

  const begin = async () => {
    setBusy(true);
    try {
      const res = await startLesson(nodeId, length);
      setSession({ id: res.session_id, turnLimit: res.turn_limit });
      setMessages(res.messages.map((m, i) => ({ id: `h${i}`, role: m.role, text: m.text })));
      setTurn(res.messages.filter((m) => m.role === 'student').length);
      if (res.resumed) overlay.snack(t('lucas.resumed'));
    } catch (e) {
      const code = (e as { code?: string }).code;
      overlay.snack(code === 'budget_exhausted' ? t('budget.user_daily') : messageFor(e, t('error.generation')));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!session || !text || thinking) return;
    setInput('');
    stopReading();
    seq.current += 1;
    const lucasId = `l${seq.current}`;
    setMessages((m) => [...m, { id: `s${seq.current}`, role: 'student', text }, { id: lucasId, role: 'lucas', text: '' }]);
    setThinking(true);
    const h = sendToLucas(session.id, text, spoken ? 'voice' : 'text', {
      onDelta: (d) => setMessages((all) => all.map((m) => (m.id === lucasId ? { ...m, text: m.text + d } : m))),
      onDone: (d) => {
        setThinking(false);
        const r = d.result as { turn: number; final: boolean; support: boolean } | undefined;
        if (r) setTurn(r.turn);
        setMessages((all) => {
          const reply = all.find((m) => m.id === lucasId);
          if (reply && readReplies) readAloud('lucas.reply', reply.text);
          return all.map((m) => (m.id === lucasId ? { ...m, support: r?.support } : m));
        });
        if (r?.final) void finish();
      },
    });
    setSpoken(false);
    handle.current = h;
    h.done.catch((e: { code?: string }) => {
      setThinking(false);
      setMessages((all) => all.filter((m) => m.id !== lucasId));
      if (e.code !== 'cancelled') overlay.snack(e.code === 'budget_exhausted' ? t('budget.user_daily') : messageFor(e, t('error.generation')));
    });
  };

  const finish = async () => {
    if (!session) return;
    setBusy(true);
    try {
      setResult(await finishLesson(session.id));
    } catch (e) {
      overlay.snack(messageFor(e, t('error.generation')));
    } finally {
      setBusy(false);
    }
  };

  if (result) return <LucasResult result={result} subjectId={subjectId} nodeId={nodeId} onRetry={() => (setResult(null), setSession(null), setMessages([]), setTurn(0))} userId={userId} />;

  if (!session) {
    return (
      <Screen title={t('lucas.title')} closeIcon onBack={() => router.back()}>
        <Text variant="heading">{node.node?.title ?? ''}</Text>
        <Text tone="secondary">{t('lucas.intro')}</Text>
        <SegmentedControl<LessonLength>
          label={t('lucas.length')}
          value={length}
          onChange={setLength}
          options={[
            { value: 'short', label: lengthLabels[0] ?? 'Rápido' },
            { value: 'full', label: lengthLabels[1] ?? 'Completo' },
          ]}
        />
        <Button label={t('lucas.start')} icon="school-outline" loading={busy} disabled={!online} disabledReason={online ? undefined : t('offline.ai_disabled')} onPress={() => void begin()} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <AppBar
        title={t('lucas.title')}
        closeIcon
        onBack={() => router.back()}
        context={
          <View style={{ gap: space.xs }}>
            <Row>
              <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                {t('lucas.turn_of', { i: turn, n: session.turnLimit })}
              </Text>
              <Button compact variant="text" label={readReplies ? t('lucas.read_off') : t('lucas.read_on')} onPress={() => setReadReplies((v) => !v)} />
            </Row>
            <ProgressBar value={turn / session.turnLimit} />
          </View>
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.role === 'student' ? { alignSelf: 'flex-end', backgroundColor: c.primarySoft } : { backgroundColor: c.surface1 }]}>
              {item.role === 'lucas' ? <Text variant="label" tone="accent">Lucas</Text> : null}
              <Text>{item.text || (thinking ? t('lucas.thinking') : '')}</Text>
              {item.support ? <Banner kind="info" icon="heart-outline" message={t('help.card')} /> : null}
              {item.role === 'lucas' && item.text ? <ReadAloudButton id={`lucas:${item.id}`} text={item.text} size={18} /> : null}
            </View>
          )}
        />
        <View style={[styles.composer, { borderTopColor: c.border, paddingBottom: insets.bottom + space.sm }]}>
          <TextInput
            value={input}
            onChangeText={(v) => setInput(v.slice(0, 2000))}
            placeholder={t('lucas.placeholder')}
            placeholderTextColor={c.textSecondary}
            editable={online && !thinking}
            multiline
            accessibilityLabel={t('lucas.placeholder')}
            style={[type('body'), styles.input, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.surface1 }]}
          />
          <MicButton disabled={!online || thinking} onText={(said) => (setSpoken(true), setInput((v) => appendTranscript(v, said)))} />
          <Button compact label={t('tutor.send')} disabled={!input.trim() || thinking || !online} onPress={send} />
        </View>
        <View style={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.sm }}>
          <Button variant="secondary" label={t('lucas.end')} loading={busy} disabled={thinking} onPress={() => void finish()} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function LucasResult({ result, subjectId, nodeId, onRetry, userId }: { result: TeachingFinishRes; subjectId: string; nodeId: string; onRetry: () => void; userId: string | null }) {
  const overlay = useOverlay();
  const bandLabels = options('lucas.bands');
  const rubric = [
    ['misconceptions', result.rubric.misconceptions],
    ['coverage', result.rubric.coverage],
    ['accuracy', result.rubric.accuracy],
    ['clarity', result.rubric.clarity],
  ] as const;
  const weak = [...result.gaps.map((g) => ({ front: g.kind === 'misconception' ? t('lucas.card_myth', { text: g.text }) : t('lucas.card_explain', { text: g.text }), back: g.correct, pages: g.source_pages })), ...result.errors_taught.map((e) => ({ front: t('lucas.card_myth', { text: e.claim }), back: e.correction, pages: e.source_pages }))];
  return (
    <Screen title={t('lucas.results')} closeIcon onBack={() => router.back()}>
      <Card>
        {result.too_short ? (
          <Text>{t('lucas.too_short')}</Text>
        ) : (
          <Row>
            <ProgressRing value={(result.score ?? 0) / 100} size={88} label={t('lucas.score', { n: result.score ?? 0 })}>
              <Text variant="title">{result.score}</Text>
            </ProgressRing>
            <View style={{ flex: 1, gap: space.xs }}>
              <Text variant="heading">{t('lucas.score', { n: result.score ?? 0 })}</Text>
              <Text tone="accent">{result.band ? bandLabels[BANDS.indexOf(result.band)] : ''}</Text>
            </View>
          </Row>
        )}
      </Card>
      {!result.too_short ? (
        <Card>
          {rubric.map(([key, value]) => (
            <ProgressBar key={key} value={value} label={`${t(`lucas.rubric.${key}`)} · ${Math.round(value * 100)}%`} />
          ))}
        </Card>
      ) : null}
      {result.teach_back ? (
        <Card tone="soft">
          <Text variant="label">{t('lucas.understood')}</Text>
          <Text>{result.teach_back}</Text>
        </Card>
      ) : null}
      {result.gaps.length ? (
        <Card>
          <Text variant="heading">{t('lucas.gaps')}</Text>
          {result.gaps.map((g) => (
            <View key={g.id} style={{ gap: space.xs }}>
              <Text>• {g.kind === 'misconception' ? t('lucas.gap_myth', { text: g.text }) : g.text}</Text>
              <Text variant="bodySmall" tone="secondary">{g.correct}</Text>
              <PageChips sources={g.source_pages} subjectId={subjectId} />
            </View>
          ))}
        </Card>
      ) : null}
      {result.errors_taught.length ? (
        <Card>
          <Text variant="heading">{t('lucas.errors')}</Text>
          {result.errors_taught.map((e, i) => (
            <View key={i} style={{ gap: space.xs }}>
              <Text>✗ {e.claim}</Text>
              <Text variant="bodySmall" tone="success">✓ {e.correction}</Text>
              <PageChips sources={e.source_pages} subjectId={subjectId} />
            </View>
          ))}
        </Card>
      ) : null}
      {weak.length && userId ? (
        <Button
          variant="tonal"
          icon="albums-outline"
          label={t('lucas.make_cards')}
          onPress={async () => {
            for (const w of weak.slice(0, 8)) await createUserCard(userId, { subjectId, nodeId, type: 'basic', front: w.front, back: w.back, sourcePages: w.pages, origin: 'user', shared: false }).catch(() => undefined);
            overlay.snack(t('lucas.cards_made', { n: Math.min(8, weak.length) }));
          }}
        />
      ) : null}
      <Button label={t('lucas.retry')} icon="refresh" onPress={onRetry} />
      <View style={{ height: radius.lg }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.lg, padding: space.md, gap: space.xs, maxWidth: '88%' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 48, maxHeight: 140, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm },
});
