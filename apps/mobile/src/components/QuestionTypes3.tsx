// Phase 3 question types (spec 05): Ache o Erro (PRA-06) and problems with hints, faded worked examples and
// "Mostrar meu raciocínio" (PRA-08). Rendered by QuestionView; responses match the shared grader.
import { FIND_ERROR_TYPES } from '@studify/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { checkProblemWork } from '../features/practice/api';
import type { QuestionResponse, QuestionRow } from '../features/practice/types';
import { t } from '../i18n';
import { radius, space, touch, useTheme } from '../theme';
import { Banner } from './Banner';
import { Button } from './Button';
import { Chip, ChipGroup } from './Chip';
import { RichContent } from './MarkdownView';
import { BottomSheet } from './Overlay';
import { Text } from './Text';

interface FindErrorPayload {
  segments: { id: string; text: string }[];
  error_segment_id: string | null;
  error_type: string;
  explanation: string;
  corrected_text: string;
}

type FindErrorResponse = { segment_id: string | null; error_type?: string; explanation?: string };

/**
 * PRA-06.3: tap the wrong segment (or "Não tem erro"), then optionally say what kind of error it is. After
 * Confirmar the planted segment is marked, with the corrected text and the explanation (PRA-06.4).
 */
export function FindErrorQuestion({ payload, response, onChange, revealed }: { payload: FindErrorPayload; response: QuestionResponse | null; onChange: (r: QuestionResponse) => void; revealed?: boolean }) {
  const { colors: c } = useTheme();
  const r = response && 'segment_id' in response ? (response as FindErrorResponse) : null;
  const choose = (segmentId: string | null) => !revealed && onChange({ segment_id: segmentId, ...(r?.error_type ? { error_type: r.error_type } : {}) });
  const noError = r !== null && r.segment_id === null;
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="bodySmall" tone="secondary">
        {t('find_error.hint')}
      </Text>
      {payload.segments.map((seg) => {
        const selected = r?.segment_id === seg.id;
        const planted = revealed && payload.error_segment_id === seg.id;
        const border = planted ? c.danger : selected ? c.primary : c.border;
        return (
          <Pressable
            key={seg.id}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: !!revealed }}
            accessibilityLabel={`${seg.text}${planted ? `. ${t('find_error.this_was_wrong')}` : ''}`}
            onPress={() => choose(seg.id)}
            style={[styles.segment, { borderColor: border, backgroundColor: selected ? c.primarySoft : c.surface1 }]}
          >
            <View style={{ flex: 1, gap: space.xs }}>
              <RichContent text={seg.text} />
              {planted ? (
                <>
                  <Text variant="label" tone="danger">✗ {t('find_error.this_was_wrong')}</Text>
                  <Text variant="bodySmall">
                    {t('find_error.corrected')}: {payload.corrected_text}
                  </Text>
                </>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      <Button
        variant={noError ? 'primary' : 'secondary'}
        icon={noError ? 'checkmark-circle' : 'checkmark-circle-outline'}
        label={t('find_error.no_error')}
        disabled={revealed}
        onPress={() => choose(null)}
      />
      {r?.segment_id && !revealed ? (
        <View style={{ gap: space.xs }}>
          <Text variant="label">{t('find_error.which_type')}</Text>
          <ChipGroup>
            {Object.entries(FIND_ERROR_TYPES).map(([key, label]) => (
              <Chip key={key} label={label} selected={r.error_type === key} onPress={() => onChange({ ...r, error_type: key })} />
            ))}
          </ChipGroup>
        </View>
      ) : null}
      {revealed && payload.error_segment_id === null ? <Banner kind="info" message={t('find_error.had_no_error')} /> : null}
      {revealed && r?.error_type && payload.error_segment_id && r.segment_id === payload.error_segment_id ? (
        <Text variant="bodySmall" tone={r.error_type === payload.error_type ? 'success' : 'secondary'}>
          {r.error_type === payload.error_type ? t('find_error.type_right') : t('find_error.type_was', { type: FIND_ERROR_TYPES[payload.error_type as keyof typeof FIND_ERROR_TYPES] ?? payload.error_type })}
        </Text>
      ) : null}
    </View>
  );
}

interface WorkedExample {
  statement: string;
  steps: string[];
  answer: string;
  hidden_steps: number;
}

interface ProblemPayload {
  final_answer: number | string;
  answer_format: 'numeric' | 'expression' | 'choice';
  unit?: string | null;
  solution_steps: string[];
  hints: string[];
  worked_examples?: WorkedExample[];
}

/** PRA-08.1 faded worked examples: example 2 hides its last step, example 3 its last two, until tapped. */
function WorkedExamples({ examples }: { examples: WorkedExample[] }) {
  const { colors: c } = useTheme();
  const [shown, setShown] = useState<Record<number, boolean>>({});
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="label">{t('problem.worked_examples')}</Text>
      {examples.map((ex, i) => {
        const hidden = shown[i] ? 0 : ex.hidden_steps;
        const visible = ex.steps.slice(0, ex.steps.length - hidden);
        return (
          <View key={i} style={[styles.example, { backgroundColor: c.surface2 }]}>
            <Text variant="label">{t('problem.example_n', { n: i + 1 })}</Text>
            <RichContent text={ex.statement} variant="bodySmall" />
            {visible.map((step, j) => (
              <RichContent key={j} text={`${j + 1}. ${step}`} variant="bodySmall" />
            ))}
            {hidden > 0 ? (
              <Button compact variant="text" label={t('problem.try_next_step', { n: hidden })} onPress={() => setShown((s) => ({ ...s, [i]: true }))} />
            ) : (
              <Text variant="bodySmall" weight="bold">
                {t('problem.answer')}: {ex.answer}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * PRA-08.2–08.5: answer field (expressions are compared at random points by the shared grader), up to 3 hints
 * (each lowers the credit), and "Mostrar meu raciocínio", which points at the first wrong step.
 */
export function ProblemQuestion({
  question,
  response,
  onChange,
  revealed,
  hintsUsed = 0,
  onHint,
}: {
  question: QuestionRow;
  response: QuestionResponse | null;
  onChange: (r: QuestionResponse) => void;
  revealed?: boolean;
  hintsUsed?: number;
  onHint?: () => void;
}) {
  const { colors: c, type } = useTheme();
  const p = question.payload as unknown as ProblemPayload;
  const answer = response && 'answer' in response ? response.answer : '';
  const [working, setWorking] = useState('');
  const [sheet, setSheet] = useState(false);
  const [check, setCheck] = useState<{ index: number | null; what: string; nudge: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const runCheck = async () => {
    setBusy(true);
    try {
      const res = await checkProblemWork(question.id, working);
      setCheck({ index: res.first_wrong_step_index, what: res.what_went_wrong, nudge: res.nudge });
    } catch {
      setCheck({ index: null, what: t('error.generation'), nudge: '' });
    } finally {
      setBusy(false);
    }
  };

  const steps = working.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return (
    <View style={{ gap: space.md }}>
      {p.worked_examples?.length ? <WorkedExamples examples={p.worked_examples} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <TextInput
          editable={!revealed}
          value={answer}
          onChangeText={(v) => onChange({ answer: v })}
          placeholder={p.answer_format === 'expression' ? t('problem.expression_placeholder') : t('problem.answer_placeholder')}
          placeholderTextColor={c.textSecondary}
          keyboardType={p.answer_format === 'numeric' ? 'decimal-pad' : 'default'}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t('problem.answer')}
          style={[type('body'), styles.input, { flex: 1, borderColor: c.primary, color: c.textPrimary }]}
        />
        {p.unit ? <Text tone="secondary">{p.unit}</Text> : null}
      </View>
      {p.hints.slice(0, hintsUsed).map((h, i) => (
        <Banner key={i} kind="info" icon="bulb-outline" title={t('problem.hint_n', { n: i + 1 })} message={h} />
      ))}
      {!revealed ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {onHint && hintsUsed < p.hints.length ? <Button compact variant="tonal" icon="bulb-outline" label={t('problem.hint_button', { i: hintsUsed + 1, n: p.hints.length })} onPress={onHint} /> : null}
          <Button compact variant="text" icon="create-outline" label={t('problem.show_work')} onPress={() => setSheet(true)} />
        </View>
      ) : (
        <View style={{ gap: space.xs }}>
          <Text variant="label">{t('problem.solution')}</Text>
          {p.solution_steps.map((s, i) => (
            <RichContent key={i} text={`${i + 1}. ${s}`} variant="bodySmall" />
          ))}
          <Text weight="bold">
            {t('problem.answer')}: {String(p.final_answer)}
            {p.unit ? ` ${p.unit}` : ''}
          </Text>
        </View>
      )}
      <BottomSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        title={t('problem.show_work')}
        footer={<Button label={t('problem.check_work')} loading={busy} disabled={!working.trim()} onPress={() => void runCheck()} />}
      >
        <Text variant="bodySmall" tone="secondary">
          {t('problem.show_work_hint')}
        </Text>
        <TextInput
          multiline
          value={working}
          onChangeText={setWorking}
          maxLength={6000}
          accessibilityLabel={t('problem.show_work')}
          placeholder={t('problem.work_placeholder')}
          placeholderTextColor={c.textSecondary}
          style={[type('body'), styles.input, { minHeight: 160, textAlignVertical: 'top', borderColor: c.border, color: c.textPrimary }]}
        />
        {check ? (
          <View style={{ gap: space.xs }}>
            {check.index !== null && steps[check.index] ? (
              <Text variant="label" tone="danger">
                {t('problem.wrong_step', { n: check.index + 1, step: steps[check.index] })}
              </Text>
            ) : check.index === null && check.nudge ? (
              <Text variant="label" tone="success">{t('problem.no_wrong_step')}</Text>
            ) : null}
            <Text>{check.what}</Text>
            {check.nudge ? <Text tone="accent">{check.nudge}</Text> : null}
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, borderWidth: 1.5, borderRadius: radius.md, padding: space.md },
  example: { borderRadius: radius.md, padding: space.md, gap: space.xs },
  input: { borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: touch.min },
});
