import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AiBadge, AppBar, Banner, Button, Chip, ChipGroup, IconButton, OfflineBanner, PageChips, RichContent, SegmentedControl, Text, useOnline, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { createUserCard, type Citation } from '../../features/learn/api';
import { useSubject } from '../../features/subjects/api';
import { rateMessage, sendTutorMessage, stripSafetyMarkers, useThreadMessages, useThreads, type TutorMode } from '../../features/tutor/api';
import type { TutorScope } from '../../features/tutor/open';
import { MicButton, voiceErrorText } from '../../features/voice/VoiceButtons';
import { appendTranscript } from '../../features/voice/speech-text';
import { readAloud, stopReading, useReadAloud, useVoiceInput } from '../../features/voice/voice';
import { options, t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
  general: boolean;
  status: 'streaming' | 'complete' | 'interrupted' | 'refused' | 'failed';
  notInMaterial?: { nearest?: string } | null;
  distress?: boolean;
  serverId?: string;
}

const MAX_CHARS = 4000;

/** S-TUT-02 Tutor (modal): scope, modes, streaming answer with 📄 chips, follow-ups, voice (TUT-01…06). */
export default function TutorThread() {
  const params = useLocalSearchParams<{ threadId: string; scope?: string; mode?: TutorMode; prefill?: string }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const online = useOnline();
  const overlay = useOverlay();
  const { userId } = useSession();
  const [threadId, setThreadId] = useState<string | null>(params.threadId === 'new' ? null : params.threadId);
  const threads = useThreads();
  const thread = threads.data?.find((x) => x.id === threadId);
  const scope = useMemo<TutorScope | null>(() => {
    if (params.scope) return JSON.parse(params.scope) as TutorScope;
    if (thread) return { type: thread.scope_type === 'capture' ? 'subject' : thread.scope_type, subject_id: thread.subject_id ?? undefined, node_id: thread.node_id ?? undefined, goal_id: thread.goal_id ?? undefined, passage: thread.passage ?? undefined };
    return null;
  }, [params.scope, thread]);
  const subject = useSubject(scope?.subject_id);
  const [mode, setMode] = useState<TutorMode>(params.mode ?? thread?.mode ?? 'answer');
  const history = useThreadMessages(threadId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState(params.prefill ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [limitLeft, setLimitLeft] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<'limit' | null>(null);
  const handle = useRef<{ cancel: () => void } | null>(null);
  const list = useRef<FlatList<UiMessage>>(null);
  // TUT-06 Conversa por voz: answers are spoken, then the app listens again; Me testa is text-only (TUT-06.5).
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false);
  voiceModeRef.current = voiceMode;
  const speech = useReadAloud('tutor.answer');
  const handsFree = useVoiceInput((text) => send(text, false, true));
  const modeLabels = options('tutor.modes');
  const followups = options('tutor.followups');

  useEffect(() => {
    if (!history.data) return;
    setMessages(
      history.data
        .filter((m) => m.role !== 'system_note')
        .map((m) => {
          const s = stripSafetyMarkers(m.content);
          return { id: m.id, serverId: m.id, role: m.role as 'user' | 'assistant', text: s.text, citations: m.citations ?? [], general: m.general_knowledge, status: m.status, distress: s.distress || m.safety_flag === 'distress' };
        }),
    );
  }, [history.data]);

  useEffect(() => () => handle.current?.cancel(), []);

  const scopeLabel = scope?.type === 'passage' ? 'Este trecho' : scope?.type === 'topic' ? 'Este tópico' : (subject.data?.name ?? '');

  const send = (text: string, allowGeneral = false, spoken = false) => {
    const body = text.trim();
    if (!body || !online) return;
    stopReading();
    setInput('');
    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', text: body, citations: [], general: false, status: 'complete' }, { id: assistantId, role: 'assistant', text: '', citations: [], general: allowGeneral, status: 'streaming' }]);
    setStatus(null);
    const patch = (fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m) => (m.id === assistantId ? fn(m) : m)));
    const timer = setTimeout(() => setStatus(t('tutor.thinking')), 3000);
    const { handle: h } = sendTutorMessage(
      { ...(threadId ? { thread_id: threadId } : { scope: scope ?? undefined }), mode, message: body, allow_general_answer: allowGeneral || undefined, voice: spoken || voiceModeRef.current || undefined },
      {
        onMeta: (d) => {
          if (d.thread_id) setThreadId(String(d.thread_id));
          if (d.message_id) patch((m) => ({ ...m, serverId: String(d.message_id) }));
        },
        onStatus: (key) => setStatus(key === 'tutor.searching_pages' ? t('tutor.reading') : t(key, { defaultValue: t('tutor.thinking') })),
        onDelta: (d) => {
          clearTimeout(timer);
          setStatus(null);
          patch((m) => ({ ...m, text: m.text + d }));
        },
        onCitation: (c) => patch((m) => ({ ...m, citations: [...m.citations, c] })),
        onTool: (name, payload) => {
          // TUT-04: the model marks questions outside the material.
          if (name === 'marcar_fora_do_material') patch((m) => ({ ...m, notInMaterial: { nearest: (payload as { topico_mais_proximo?: string } | null)?.topico_mais_proximo } }));
        },
        onDone: (d) => {
          clearTimeout(timer);
          setStatus(null);
          patch((m) => {
            const s = stripSafetyMarkers(m.text);
            const done = { ...m, text: d.stop_reason === 'refusal' ? t('ai.refusal') : s.text, distress: s.distress, status: d.stop_reason === 'refusal' ? 'refused' as const : 'complete' as const };
            // TUT-06.3: in voice mode the answer is spoken, then the app listens for the next question.
            if (voiceModeRef.current && done.text) readAloud('tutor.answer', done.text, { onDone: () => voiceModeRef.current && void handsFree.start() });
            return done;
          });
          if (typeof d.usage_pct_today === 'number' && d.usage_pct_today >= 80) setLimitLeft(Math.max(0, Math.round((100 - d.usage_pct_today) / 1.6)));
        },
        onError: (e) => {
          clearTimeout(timer);
          setStatus(null);
          if (e.code === 'budget_exhausted' || e.code === 'rate_limited') {
            setBlocked('limit');
            setMessages((all) => all.filter((m) => m.id !== assistantId));
          } else patch((m) => ({ ...m, status: 'interrupted' }));
        },
      },
    );
    handle.current = h;
  };

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <OfflineBanner />
      <AppBar
        title={t('tutor.title')}
        closeIcon
        onBack={() => (stopReading(), router.back())}
        actions={
          <IconButton
            icon={voiceMode ? 'headset' : 'headset-outline'}
            label={voiceMode ? t('tutor.voice_mode_off') : t('tutor.voice_mode_on')}
            onPress={() => {
              const next = !voiceMode;
              setVoiceMode(next);
              if (next) {
                if (mode === 'quiz') setMode('answer');
                void handsFree.start();
              } else {
                handsFree.stop();
                stopReading();
              }
            }}
          />
        }
        context={
          <View style={{ gap: space.sm }}>
            <Text variant="bodySmall" tone="secondary">
              {t('tutor.scope', { scope: scopeLabel })}
            </Text>
            <SegmentedControl<TutorMode>
              value={mode}
              onChange={(m) => {
                if (m === 'quiz' && voiceMode) overlay.snack(t('tutor.voice_no_quiz'));
                else setMode(m);
              }}
              options={[
                { value: 'answer', label: modeLabels[0] ?? 'Responder' },
                { value: 'socratic', label: modeLabels[1] ?? 'Socrático' },
                { value: 'quiz', label: modeLabels[2] ?? 'Me testa' },
              ]}
            />
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
          ListHeaderComponent={
            <View style={{ gap: space.md }}>
              <Banner kind="neutral" icon="sparkles-outline" message={t('tutor.disclosure')} />
              {!messages.length ? <Text tone="secondary">{t('tutor.empty')}</Text> : null}
              {scope?.passage ? (
                <View style={[styles.passage, { borderColor: colors.border }]}>
                  <Text variant="label">{t('tutor.passage')}</Text>
                  <Text variant="bodySmall" numberOfLines={6}>
                    {scope.passage.text}
                  </Text>
                </View>
              ) : null}
            </View>
          }
          renderItem={({ item }) =>
            item.role === 'user' ? (
              <View style={[styles.bubble, styles.user, { backgroundColor: colors.primarySoft }]}>
                <Text>{item.text}</Text>
              </View>
            ) : (
              <View style={[styles.bubble, { backgroundColor: colors.surface1 }]}>
                {item.notInMaterial ? (
                  <View style={{ gap: space.sm }}>
                    <Text variant="label">{t('tutor.not_in_material', { subject: subject.data?.name ?? '' })}</Text>
                    {item.notInMaterial.nearest ? <Text tone="secondary">{t('tutor.nearest', { topic: item.notInMaterial.nearest })}</Text> : null}
                    {lastUser ? <Button compact variant="tonal" label={t('tutor.general_cta')} onPress={() => send(lastUser.text, true)} /> : null}
                  </View>
                ) : null}
                {item.text ? <RichContent text={item.text} /> : item.status === 'streaming' ? <Text tone="secondary">{status ?? '…'}</Text> : null}
                {item.distress ? <Banner kind="info" icon="heart-outline" message={t('help.card')} /> : null}
                <PageChips sources={item.citations} subjectId={scope?.subject_id} max={6} />
                {item.status === 'interrupted' ? (
                  <Row2>
                    <Text tone="warning">{t('tutor.interrupted')}</Text>
                    {lastUser ? <Button compact variant="text" label={t('global.retry')} onPress={() => send(lastUser.text)} /> : null}
                  </Row2>
                ) : null}
                {item.status === 'complete' && item.text ? (
                  <>
                    <AiBadge general={item.general} />
                    {item.general ? <Text variant="bodySmall" tone="info">{t('tutor.general_badge')}</Text> : null}
                    <ChipGroup>
                      {followups.map((f, i) =>
                        i === 3 ? (
                          <Chip
                            key={f}
                            label={f}
                            icon="add"
                            onPress={async () => {
                              if (!scope?.subject_id || !scope.node_id) return overlay.snack(t('error.generic'));
                              await createUserCard(userId!, { subjectId: scope.subject_id, nodeId: scope.node_id, type: 'basic', front: lastUser?.text ?? '', back: item.text.slice(0, 800), sourcePages: item.citations, origin: 'from_tutor', shared: false }).catch(() => undefined);
                              overlay.snack(t('tutor.card_created'));
                            }}
                          />
                        ) : (
                          <Chip key={f} label={f} onPress={() => (i === 2 ? (setMode('quiz'), send(f)) : send(f))} />
                        ),
                      )}
                    </ChipGroup>
                    {item.serverId ? (
                      <Row2>
                        <IconButton icon="thumbs-up-outline" label="Gostei" size={20} onPress={() => void rateMessage(item.serverId!, 1)} />
                        <IconButton icon="thumbs-down-outline" label="Não gostei" size={20} onPress={() => void rateMessage(item.serverId!, -1)} />
                      </Row2>
                    ) : null}
                  </>
                ) : null}
              </View>
            )
          }
        />
        {voiceMode ? (
          <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
            {speech.speaking ? (
              <Button variant="tonal" icon="hand-left-outline" label={t('tutor.tap_to_stop')} onPress={() => (stopReading(), void handsFree.start())} />
            ) : (
              <Text variant="bodySmall" tone="secondary" align="center">
                {handsFree.listening ? handsFree.partial || t('voice.listening') : t('tutor.voice_mode_hint')}
              </Text>
            )}
            {handsFree.error ? <Text variant="caption" tone="warning" align="center">{voiceErrorText(handsFree.error)}</Text> : null}
          </View>
        ) : null}
        {blocked === 'limit' ? <Banner kind="warning" message={t('tutor.limit_reached')} action={{ label: t('review.start'), onPress: () => router.replace('/review') }} /> : null}
        {limitLeft !== null && !blocked ? <Text variant="bodySmall" tone="secondary" align="center">{t('tutor.limit_warning', { n: limitLeft })}</Text> : null}
        {mode === 'socratic' && messages.length > 1 ? (
          <View style={{ paddingHorizontal: space.lg }}>
            <Button compact variant="text" label={t('tutor.give_up')} onPress={() => (setMode('answer'), send(t('tutor.give_up')))} />
          </View>
        ) : null}
        <View style={[styles.composer, { borderTopColor: colors.border, paddingBottom: insets.bottom + space.sm, backgroundColor: colors.bg }]}>
          <TextInput
            value={input}
            onChangeText={(v) => setInput(v.slice(0, MAX_CHARS))}
            placeholder={online ? (subject.data ? t('tutor.placeholder', { subject: subject.data.name }) : t('tutor.placeholder_generic')) : t('tutor.offline')}
            placeholderTextColor={colors.textSecondary}
            editable={online && blocked !== 'limit'}
            multiline
            accessibilityLabel={t('tutor.placeholder_generic')}
            style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface1 }]}
          />
          <MicButton disabled={!online || blocked === 'limit'} onText={(said) => setInput((v) => appendTranscript(v, said).slice(0, MAX_CHARS))} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tutor.send')}
            disabled={!input.trim() || !online}
            onPress={() => send(input)}
            style={[styles.send, { backgroundColor: input.trim() && online ? colors.primary : colors.surface2 }]}
          >
            <Ionicons name="arrow-up" size={22} color={input.trim() && online ? colors.onPrimary : colors.textSecondary} />
          </Pressable>
        </View>
        {input.length > 3500 ? <Text variant="bodySmall" tone="secondary" align="right" style={{ paddingHorizontal: space.lg }}>{t('tutor.char_count', { n: input.length })}</Text> : null}
      </KeyboardAvoidingView>
    </View>
  );
}

function Row2({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>{children}</View>;
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.lg, padding: space.md, gap: space.sm, maxWidth: '92%' },
  user: { alignSelf: 'flex-end' },
  passage: { borderLeftWidth: 4, paddingLeft: space.md, gap: 4 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 48, maxHeight: 140, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 16 },
  send: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
