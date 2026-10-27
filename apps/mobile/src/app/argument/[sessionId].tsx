import type { ArgumentTurnResult } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { AiBadge, AppBar, Button, Card, Chip, ChipGroup, ErrorState, RichContent, SkeletonList, Text, useOnline, useOverlay } from '../../components';
import { finishArgument, sendArgument, useArgumentSession, useEnemEssay, type ArgumentSessionRow } from '../../features/enem/api';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

const CRITERIA = ['tese', 'fundamentacao', 'repertorio', 'coerencia', 'refutacao', 'falacias'] as const;

/**
 * S-ARG session (INT-03.2–03.6): thesis step, then rounds against the Advogado do Diabo (streamed) with the 0–4 rubric,
 * fallacies and a tip after each; the finish shows the summary and, for ENEM, an essay outline that opens the editor.
 */
export default function ArgumentSession() {
  const { sessionId, opening } = useLocalSearchParams<{ sessionId: string; opening?: string }>();
  const session = useArgumentSession(sessionId);
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c, type } = useTheme();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ user: string; reply: string } | null>(null);
  const [lastThesis, setLastThesis] = useState<Extract<ArgumentTurnResult, { stage: 'thesis' }>['thesis_feedback'] | null>(null);
  const [finishing, setFinishing] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const s = session.data;
  const draft = useEnemEssay(s?.essay_id ?? undefined);

  if (session.isError) return <ErrorState onRetry={session.refetch} />;
  if (!s) return <SkeletonList rows={4} />;

  const send = () => {
    const text = input.trim();
    if (!text || pending) return;
    setInput('');
    setPending({ user: text, reply: '' });
    sendArgument(s.id, text, {
      onDelta: (d) => setPending((p) => (p ? { ...p, reply: p.reply + d } : p)),
      onDone: (done) => {
        const result = done.result as ArgumentTurnResult | undefined;
        if (result?.stage === 'thesis') setLastThesis(result.thesis_feedback);
        void session.refetch().then(() => setPending(null));
        scroll.current?.scrollToEnd({ animated: true });
      },
      onError: (e) => {
        setPending(null);
        setInput(text);
        overlay.snack(e.message ?? t('error.generic'));
      },
    });
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await finishArgument(s.id, s.goal_mode === 'enem');
      await session.refetch();
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generic'));
    } finally {
      setFinishing(false);
    }
  };

  const done = s.status === 'finished';
  const roundsLeft = s.thesis ? s.round_limit - s.rounds.length : null;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppBar title={t('arg.title')} closeIcon onBack={() => router.back()} actions={<AiBadge />} />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Text variant="heading">{s.theme}</Text>
        <Text variant="caption" tone="secondary">
          {t('arg.role_note')}
        </Text>
        <Bubble side="ai" text={opening ?? t('arg.thesis_prompt')} />
        {s.thesis ? <Bubble side="me" text={s.thesis} /> : null}
        {s.thesis_feedback ?? lastThesis ? <ThesisCard fb={(s.thesis_feedback ?? lastThesis)!} /> : null}
        {s.rounds.map((r, i) => (
          <View key={r.at} style={{ gap: space.sm }}>
            <Text variant="caption" tone="secondary">
              {t('arg.round', { n: i + 1, m: s.round_limit })}
            </Text>
            <Bubble side="me" text={r.user_text} />
            <Bubble side="ai" text={r.opponent_text} />
            <RoundFeedback feedback={r.feedback} />
          </View>
        ))}
        {pending ? (
          <>
            <Bubble side="me" text={pending.user} />
            {pending.reply ? <Bubble side="ai" text={pending.reply} /> : <SkeletonList rows={1} />}
          </>
        ) : null}
        {done ? <Summary s={s} essayText={draft.data?.text ?? null} /> : null}
      </ScrollView>
      {!done ? (
        <View style={{ padding: space.md, gap: space.sm, borderTopWidth: 1, borderColor: c.border }}>
          {roundsLeft !== null && roundsLeft <= 0 ? (
            <Button label={t('arg.finish')} loading={finishing} disabled={!online} onPress={() => void finish()} />
          ) : (
            <>
              <TextInput
                multiline
                value={input}
                onChangeText={setInput}
                maxLength={3000}
                placeholder={s.thesis ? t('arg.placeholder') : t('arg.thesis_prompt')}
                accessibilityLabel={s.thesis ? t('arg.placeholder') : t('arg.thesis_prompt')}
                style={[type('body'), { borderWidth: 1.5, borderColor: c.border, borderRadius: radius.md, padding: space.sm, maxHeight: 140, color: c.textPrimary }]}
              />
              <Button label={t('arg.send')} disabled={!online || !input.trim() || pending !== null} onPress={send} />
              {s.rounds.length > 0 ? <Button variant="text" label={t('arg.finish')} loading={finishing} disabled={!online || pending !== null} onPress={() => void finish()} /> : null}
            </>
          )}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function Bubble({ side, text }: { side: 'me' | 'ai'; text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ alignSelf: side === 'me' ? 'flex-end' : 'flex-start', maxWidth: '88%', backgroundColor: side === 'me' ? c.primarySoft : c.surface2, borderRadius: radius.lg, padding: space.md }}>
      <RichContent text={text} variant="body" />
    </View>
  );
}

function ThesisCard({ fb }: { fb: NonNullable<ArgumentSessionRow['thesis_feedback']> }) {
  return (
    <Card tone="soft">
      <ChipGroup>
        <Chip label={`${fb.clear ? '✓' : '✗'} ${t('arg.thesis_check.clear')}`} />
        <Chip label={`${fb.has_position ? '✓' : '✗'} ${t('arg.thesis_check.position')}`} />
        <Chip label={`${fb.specific ? '✓' : '✗'} ${t('arg.thesis_check.specific')}`} />
      </ChipGroup>
      <Text variant="bodySmall">{fb.feedback}</Text>
      {fb.suggestion ? <Text variant="bodySmall" tone="accent">→ {fb.suggestion}</Text> : null}
    </Card>
  );
}

function RoundFeedback({ feedback }: { feedback: ArgumentSessionRow['rounds'][number]['feedback'] }) {
  return (
    <Card>
      <ChipGroup>
        {CRITERIA.map((k) => (
          <Chip key={k} label={`${t(`arg.rubric.${k}`)} ${feedback.rubric[k] ?? 0}/4`} />
        ))}
      </ChipGroup>
      {feedback.fallacies.length ? <Text variant="label">{t('arg.fallacies')}</Text> : null}
      {feedback.fallacies.map((f) => (
        <Text key={f.name + f.quote} variant="bodySmall">
          • {f.name}: “{f.quote}” — {f.explanation}
        </Text>
      ))}
      <Text variant="bodySmall" tone="accent">
        {t('arg.tip')}: {feedback.tip}
      </Text>
    </Card>
  );
}

function Summary({ s, essayText }: { s: ArgumentSessionRow; essayText: string | null }) {
  const sum = s.summary;
  const o = s.outline;
  return (
    <View style={{ gap: space.md }}>
      <Card tone="soft">
        <Text variant="heading">{t('arg.summary')}</Text>
        {s.rubric ? <Text variant="title">{t('arg.total', { n: s.rubric.total })}</Text> : null}
        {s.rubric ? (
          <ChipGroup>
            {CRITERIA.map((k) => (
              <Chip key={k} label={`${t(`arg.rubric.${k}`)} ${s.rubric![k] ?? 0}/4`} />
            ))}
          </ChipGroup>
        ) : null}
        {sum?.strongest_argument ? (
          <>
            <Text variant="label">{t('arg.strongest')}</Text>
            <Text variant="bodySmall">{sum.strongest_argument}</Text>
          </>
        ) : null}
        {sum?.weakest_point ? (
          <>
            <Text variant="label">{t('arg.weakest')}</Text>
            <Text variant="bodySmall">{sum.weakest_point}</Text>
          </>
        ) : null}
        {sum?.fallacies.length ? <Text variant="bodySmall">{t('arg.fallacies')}: {sum.fallacies.map((f) => `${f.name} (${f.count})`).join(', ')}</Text> : null}
        {sum?.repertorio_suggestions.length ? <Text variant="label">{t('arg.suggestions')}</Text> : null}
        {sum?.repertorio_suggestions.map((r) => (
          <Text key={r.text} variant="bodySmall">
            • {r.text} <Text variant="caption" tone="secondary">({r.origin === 'material' ? t('arg.repertorio_material') : t('arg.repertorio_geral')})</Text>
          </Text>
        ))}
      </Card>
      {o ? (
        <Card>
          <Text variant="heading">{t('arg.outline')}</Text>
          <Text variant="bodySmall">
            <Text variant="label">{t('arg.outline_parts.intro')}: </Text>
            {o.introducao.contexto} {o.introducao.tese}
          </Text>
          {[o.d1, o.d2].map((d, i) => (
            <Text key={i} variant="bodySmall">
              <Text variant="label">{t('arg.outline_parts.dev', { n: i + 1 })}: </Text>
              {d.topico} {d.argumento}
              {d.repertorio ? ` (${d.repertorio})` : ''}
            </Text>
          ))}
          <Text variant="bodySmall">
            <Text variant="label">{t('arg.outline_parts.concl')}: </Text>
            {o.conclusao.retomada} {o.conclusao.proposta.agente}, {o.conclusao.proposta.acao}, {o.conclusao.proposta.meio}, {o.conclusao.proposta.finalidade}. {o.conclusao.proposta.detalhamento}
          </Text>
          <Button
            icon="create-outline"
            label={t('arg.write_essay')}
            onPress={() =>
              router.push({
                pathname: '/enem/essay/new',
                params: { ...(s.essay_id ? { essayId: s.essay_id } : {}), ...(s.theme_id ? { themeId: s.theme_id } : { themeTitle: s.theme }), ...(essayText ? { text: essayText } : {}) },
              })
            }
          />
        </Card>
      ) : null}
    </View>
  );
}
