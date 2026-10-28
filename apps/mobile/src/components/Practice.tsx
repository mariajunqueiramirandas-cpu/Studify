import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { options, t } from '../i18n';
import type { Confidence, MistakeCause, Option, QuestionRow, QuestionResponse, GradeResult } from '../features/practice/types';
import { MISTAKE_CAUSES } from '../features/practice/types';
import { cheer, thud } from '../lib/haptics';
import { radius, shade, space, useTheme } from '../theme';
import { Button } from './Button';
import { Chip, ChipGroup, PageChips } from './Chip';
import { RichContent } from './MarkdownView';
import { RichText, Text } from './Text';
import { ReadAloudButton } from '../features/voice/VoiceButtons';

/** PRA-05: "Quão confiante você está?" — 4 chips, single select. */
export function ConfidencePicker({ value, onChange }: { value: Confidence | null; onChange: (c: Confidence) => void }) {
  const labels = options('quiz.confidence.levels');
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label">{t('quiz.confidence.title')}</Text>
      <ChipGroup>
        {labels.map((label, i) => (
          <Chip key={label} label={label} selected={value === i + 1} onPress={() => onChange((i + 1) as Confidence)} />
        ))}
      </ChipGroup>
    </View>
  );
}

function correctLetter(q: QuestionRow): string | null {
  const p = q.payload as Record<string, unknown>;
  if (q.type === 'mcq_single') return p.correct as string;
  if (q.type === 'multi_select') return (p.correct as string[]).join(', ');
  if (q.type === 'true_false') return (p.correct as boolean) ? t('quiz.true') : t('quiz.false');
  return null;
}

/** S-PRA-05 feedback panel (PRA-02): result line, rationale, 📄, explanation. */
export function FeedbackPanel({
  question,
  response,
  result,
  onAskTutor,
  onExplain,
  onFlag,
}: {
  question: QuestionRow;
  response: QuestionResponse | null;
  result: GradeResult;
  onAskTutor?: () => void;
  onExplain?: () => void;
  onFlag?: () => void;
}) {
  const { colors: c } = useTheme();
  const p = question.payload as Record<string, unknown>;
  const letter = correctLetter(question);
  const picked = response && 'choice' in response ? response.choice : null;
  const pickedOption = picked ? ((p.options as Option[]) ?? []).find((o) => o.id === picked) : null;
  const correctOption = question.type === 'mcq_single' ? ((p.options as Option[]) ?? []).find((o) => o.id === p.correct) : null;
  const partial = result.score != null && result.score > 0 && result.score < 1;

  const header = result.pending
    ? t('quiz.offline_grading')
    : result.correct
      ? t('quiz.correct')
      : partial
        ? t('quiz.partial', { k: Math.round((result.score ?? 0) * 10), n: 10 })
        : letter && question.type === 'mcq_single'
          ? t('quiz.wrong', { letter })
          : t('quiz.wrong_generic');

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(result.correct ? 'Resposta certa' : `Resposta errada.${letter ? ` A certa é a ${letter}.` : ''}`);
    if (result.pending) return;
    if (result.correct) cheer();
    else thud();
  }, [result.correct, result.pending, letter]);

  const color = result.pending ? c.info : result.correct ? c.success : partial ? c.warning : c.danger;
  const soft = result.pending ? c.infoSoft : result.correct ? c.successSoft : partial ? c.warningSoft : c.dangerSoft;
  return (
    <View style={[styles.feedback, { borderColor: color, borderBottomColor: shade(color, 0.25), backgroundColor: c.surface1 }]} accessibilityLiveRegion="polite">
      <View style={[styles.verdict, { backgroundColor: soft }]}>
        <View style={[styles.badge, { backgroundColor: color }]}>
          <Ionicons name={result.pending ? 'time-outline' : result.correct ? 'checkmark' : partial ? 'remove' : 'close'} size={24} color={c.onPrimary} />
        </View>
        <RichText variant="heading" style={{ flex: 1, color }}>
          {header}
        </RichText>
      </View>
      {result.typo ? <RichText tone="secondary">{t('quiz.typo', { word: result.typo })}</RichText> : null}
      {!result.correct && pickedOption?.rationale ? (
        <View style={{ gap: space.xs }}>
          <Text variant="label">{t('quiz.why_wrong', { letter: pickedOption.id })}</Text>
          <RichContent variant="reading" text={pickedOption.rationale} />
        </View>
      ) : null}
      {correctOption?.rationale ? (
        <View style={{ gap: space.xs }}>
          <Text variant="label">{t('quiz.correct_answer')}</Text>
          <RichContent variant="reading" text={correctOption.rationale} />
        </View>
      ) : null}
      {question.type === 'true_false' && typeof p.justification === 'string' ? <RichContent variant="reading" text={p.justification} /> : null}
      {question.explanation ? (
        <View style={{ gap: space.xs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text variant="label" style={{ flex: 1 }}>
              {t('quiz.explanation')}
            </Text>
            <ReadAloudButton id={`explanation:${question.id}`} text={question.explanation} size={20} />
          </View>
          <RichContent variant="reading" text={question.explanation} />
        </View>
      ) : null}
      <PageChips sources={question.source_pages} subjectId={question.subject_id} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {onAskTutor && !result.correct ? <Button compact variant="tonal" icon="chatbubbles-outline" label={t('quiz.dont_understand')} onPress={onAskTutor} /> : null}
        {onExplain ? <Button compact variant="text" label={t('notes.explain')} onPress={onExplain} /> : null}
        {onFlag ? <Button compact variant="text" label={t('global.report_error')} onPress={onFlag} /> : null}
      </View>
    </View>
  );
}

const CAUSE_KEYS: Record<MistakeCause, number> = { didnt_know: 0, confused: 1, careless: 2, misread: 3 };

export function causeLabel(cause: MistakeCause | string | null | undefined): string {
  if (!cause) return t('mistakes.no_cause');
  return options('mistakes.cause.options')[CAUSE_KEYS[cause as MistakeCause] ?? 0] ?? cause;
}

/** PRA-04: "Por que você errou?" with the suggested cause preselected. */
export function CausePicker({ value, suggested, onChange }: { value: MistakeCause | null; suggested?: MistakeCause | null; onChange: (c: MistakeCause) => void }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label">{t('mistakes.cause.title')}</Text>
      <ChipGroup>
        {MISTAKE_CAUSES.map((cause) => (
          <Chip
            key={cause}
            label={cause === suggested && value !== cause ? `${causeLabel(cause)} · ${t('mistakes.suggested')}` : causeLabel(cause)}
            selected={value === cause}
            onPress={() => onChange(cause)}
          />
        ))}
      </ChipGroup>
    </View>
  );
}

/** Duels and battles: 30 s ring; color shift + haptic tick in the last 5 s, no flashing (ux §10). */
export function TimerRing({ totalMs, remainingMs, size = 56 }: { totalMs: number; remainingMs: number; size?: number }) {
  const { colors: c } = useTheme();
  const secs = Math.ceil(remainingMs / 1000);
  const last = useRef(secs);
  useEffect(() => {
    if (secs !== last.current && secs <= 5 && secs > 0) void Haptics.selectionAsync();
    if (secs !== last.current && (secs === 10 || secs === 60)) AccessibilityInfo.announceForAccessibility(`Faltam ${secs} segundos`);
    last.current = secs;
  }, [secs]);
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, remainingMs / totalMs));
  const color = secs <= 5 ? c.warning : c.primary;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`${secs} segundos`}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.surface2} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeDasharray={`${circ} ${circ}`} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <Text variant="label" style={{ color }}>
        {secs}
      </Text>
    </View>
  );
}

/** Top 5 + the viewer's own row (ux §5.7). */
export function Leaderboard({ rows, meId }: { rows: { id: string; name: string; score: number; rank: number }[]; meId: string }) {
  const { colors: c } = useTheme();
  const top = rows.slice(0, 5);
  const me = rows.find((r) => r.id === meId);
  const list = me && !top.some((r) => r.id === meId) ? [...top, me] : top;
  return (
    <View style={{ gap: space.sm }}>
      {list.map((r) => (
        <View key={r.id} style={[styles.lbRow, { backgroundColor: r.id === meId ? c.primarySoft : c.surface1 }]}>
          <Text variant="heading" style={{ width: 36 }}>
            {r.rank}º
          </Text>
          <Text style={{ flex: 1 }} weight={r.id === meId ? 'bold' : 'regular'}>
            {r.id === meId ? `${r.name} (${t('duel.you')})` : r.name}
          </Text>
          <Text variant="label">{t('battle.points', { n: r.score })}</Text>
        </View>
      ))}
    </View>
  );
}

/** Short celebration ≤ 1.5 s, skipped with reduced motion, after 22:00 and in Modo Véspera (ux §5.7). */
export function Celebrate({ text, calm }: { text: string; calm?: boolean }) {
  const { reduceMotion } = useTheme();
  const scale = useRef(new Animated.Value(reduceMotion || calm ? 1 : 0.85)).current;
  useEffect(() => {
    if (reduceMotion || calm || new Date().getHours() >= 22) return;
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 4 }).start();
  }, [scale, reduceMotion, calm]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Text variant="display" align="center">
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  feedback: { borderWidth: 2, borderBottomWidth: 5, borderRadius: radius.xl, padding: space.lg, gap: space.md, overflow: 'hidden' },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: -space.lg, marginTop: -space.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  badge: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  lbRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md },
});
