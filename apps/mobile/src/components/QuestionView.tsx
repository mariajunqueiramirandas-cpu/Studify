import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { t } from '../i18n';
import type { Option, QuestionResponse, QuestionRow } from '../features/practice/types';
import { radius, space, touch, useTheme } from '../theme';
import { IconButton } from './Button';
import { FindErrorQuestion, ProblemQuestion } from './QuestionTypes3';
import { RichContent } from './MarkdownView';
import { Text } from './Text';

interface Props {
  question: QuestionRow;
  response: QuestionResponse | null;
  onChange: (r: QuestionResponse) => void;
  /** After Confirmar in practice mode: lock input and color the options. */
  revealed?: boolean;
  /** Duels / battles: selection submits on tap (ux §5.2 exception). */
  submitOnTap?: (r: QuestionResponse) => void;
  /** Battle reveal: per-option distribution, only when ≥ 5 answered (SOC-03.10). */
  distribution?: Record<string, number> | null;
  /** problem (PRA-08.3): hints revealed so far and the "Dica" action; omitted where hints are not offered. */
  hintsUsed?: number;
  onHint?: () => void;
}

export function QuestionView({ question, response, onChange, revealed, submitOnTap, distribution, hintsUsed, onHint }: Props) {
  return (
    <View style={{ gap: space.lg }}>
      {question.stimulus?.markdown ? <Stimulus text={question.stimulus.markdown} /> : null}
      {question.stimulus?.table_markdown ? <Stimulus text={question.stimulus.table_markdown} /> : null}
      {question.type !== 'fill_blank' && question.type !== 'true_false' ? <RichContent text={question.stem} /> : null}
      <Body question={question} response={response} onChange={onChange} revealed={revealed} submitOnTap={submitOnTap} distribution={distribution} hintsUsed={hintsUsed} onHint={onHint} />
    </View>
  );
}

function Stimulus({ text }: { text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ backgroundColor: c.surface2, borderRadius: radius.md, padding: space.md }}>
      <RichContent text={text} variant="bodySmall" />
    </View>
  );
}

function Body({ question, response, onChange, revealed, submitOnTap, distribution, hintsUsed, onHint }: Props) {
  const p = question.payload as Record<string, unknown>;
  switch (question.type) {
    case 'mcq_single':
      return (
        <Options
          options={(p.options as Option[]) ?? []}
          selected={response && 'choice' in response ? [response.choice] : []}
          correct={revealed ? [p.correct as string] : undefined}
          distribution={distribution}
          onSelect={(id) => {
            const r = { choice: id };
            if (submitOnTap) submitOnTap(r);
            else onChange(r);
          }}
          disabled={revealed}
        />
      );
    case 'multi_select': {
      const selected = response && 'choices' in response ? response.choices : [];
      return (
        <View style={{ gap: space.sm }}>
          <Text variant="bodySmall" tone="secondary">
            {t('quiz.multi_hint')}
          </Text>
          <Options
            multi
            options={(p.options as Option[]) ?? []}
            selected={selected}
            correct={revealed ? (p.correct as string[]) : undefined}
            onSelect={(id) => onChange({ choices: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].sort() })}
            disabled={revealed}
          />
        </View>
      );
    }
    case 'true_false': {
      const value = response && 'value' in response ? response.value : null;
      const correct = p.correct as boolean;
      return (
        <View style={{ gap: space.md }}>
          <RichContent text={question.stem && question.stem !== p.statement ? `${question.stem}\n\n${String(p.statement ?? '')}` : String(p.statement ?? question.stem)} />
          <Options
            options={[
              { id: 'true', text: t('quiz.true') },
              { id: 'false', text: t('quiz.false') },
            ]}
            letters={false}
            selected={value == null ? [] : [String(value)]}
            correct={revealed ? [String(correct)] : undefined}
            onSelect={(id) => {
              const r = { value: id === 'true' };
              if (submitOnTap) submitOnTap(r);
              else onChange(r);
            }}
            disabled={revealed}
          />
        </View>
      );
    }
    case 'fill_blank':
      return <FillBlank text={String(p.text ?? question.stem)} response={response} onChange={onChange} disabled={revealed} />;
    case 'numeric':
      return <NumericInput unit={p.unit as string | undefined} response={response} onChange={onChange} disabled={revealed} />;
    case 'matching':
      return (
        <Matching
          left={(p.left as { id: string; text: string }[]) ?? []}
          right={(p.right as { id: string; text: string }[]) ?? []}
          correctPairs={revealed ? (p.pairs as [string, string][]) : undefined}
          response={response}
          onChange={onChange}
        />
      );
    case 'ordering':
      return <Ordering items={(p.items as { id: string; text: string }[]) ?? []} correct={revealed ? (p.correct_order as string[]) : undefined} response={response} onChange={onChange} seed={question.id} />;
    case 'find_error':
      return <FindErrorQuestion payload={p as never} response={response} onChange={onChange} revealed={revealed} />;
    case 'problem':
      return <ProblemQuestion question={question} response={response} onChange={onChange} revealed={revealed} hintsUsed={hintsUsed} onHint={onHint} />;
    case 'short_answer':
    case 'essay_question':
    default:
      return <ShortAnswer response={response} onChange={onChange} disabled={revealed} long={question.type === 'essay_question'} />;
  }
}

interface OptionsProps {
  options: Option[];
  selected: string[];
  correct?: string[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  multi?: boolean;
  letters?: boolean;
  distribution?: Record<string, number> | null;
}

/** Option rows: 56 dp min, letter badge A–E, whole row tappable (ux §5.2). */
export function Options({ options, selected, correct, onSelect, disabled, multi, letters = true, distribution }: OptionsProps) {
  const { colors: c } = useTheme();
  const total = distribution ? Object.values(distribution).reduce((a, b) => a + b, 0) : 0;
  return (
    <View style={{ gap: space.sm }} accessibilityRole={multi ? undefined : 'radiogroup'}>
      {options.map((o) => {
        const isSel = selected.includes(o.id);
        const isCorrect = correct?.includes(o.id);
        const isWrongPick = correct && isSel && !isCorrect;
        const border = isCorrect ? c.success : isWrongPick ? c.danger : isSel ? c.primary : c.border;
        const bg = isCorrect ? c.successSoft : isWrongPick ? c.dangerSoft : isSel ? c.primarySoft : c.surface1;
        const icon = isCorrect ? 'checkmark-circle' : isWrongPick ? 'close-circle' : null;
        const share = distribution && total > 0 ? (distribution[o.id] ?? 0) / total : null;
        return (
          <Pressable
            key={o.id}
            disabled={disabled}
            onPress={() => onSelect(o.id)}
            accessibilityRole={multi ? 'checkbox' : 'radio'}
            accessibilityState={{ selected: isSel, checked: multi ? isSel : undefined, disabled: !!disabled }}
            accessibilityLabel={`${letters ? `${o.id}. ` : ''}${o.text}${isCorrect ? `. ${t('quiz.correct_answer')}` : ''}`}
            style={[styles.option, { borderColor: border, backgroundColor: bg }]}
          >
            {share != null ? <View style={[styles.distBar, { width: `${share * 100}%`, backgroundColor: `${c.primary}22` }]} /> : null}
            {letters ? (
              <View style={[styles.letter, { backgroundColor: isSel || isCorrect ? border : c.surface2 }]}>
                <Text variant="label" style={{ color: isSel || isCorrect ? c.onPrimary : c.textPrimary }}>
                  {o.id}
                </Text>
              </View>
            ) : multi ? (
              <Ionicons name={isSel ? 'checkbox' : 'square-outline'} size={22} color={isSel ? c.primary : c.textSecondary} />
            ) : null}
            <View style={{ flex: 1 }}>
              <RichContent text={o.text} />
            </View>
            {share != null ? (
              <Text variant="label" tone="secondary">
                {Math.round(share * 100)}%
              </Text>
            ) : null}
            {icon ? <Ionicons name={icon} size={24} color={border} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function FillBlank({ text, response, onChange, disabled }: { text: string; response: QuestionResponse | null; onChange: (r: QuestionResponse) => void; disabled?: boolean }) {
  const { colors: c, type } = useTheme();
  const blanks = response && 'blanks' in response ? response.blanks : {};
  const parts = text.split(/(\{\{\s*\w+\s*\}\})/g);
  return (
    <View style={{ gap: space.md }}>
      {parts.map((part, i) => {
        const m = part.match(/\{\{\s*(\w+)\s*\}\}/);
        if (!m) return part.trim() ? <RichContent key={i} text={part.trim()} /> : null;
        const id = m[1]!;
        return (
          <TextInput
            key={i}
            editable={!disabled}
            value={blanks[id] ?? ''}
            onChangeText={(v) => onChange({ blanks: { ...blanks, [id]: v } })}
            placeholder={t('quiz.fill_placeholder')}
            placeholderTextColor={c.textSecondary}
            accessibilityLabel={`Lacuna ${id}`}
            autoCapitalize="none"
            autoCorrect={false}
            style={[type('body'), styles.input, { borderColor: c.primary, color: c.textPrimary }]}
          />
        );
      })}
    </View>
  );
}

function NumericInput({ unit, response, onChange, disabled }: { unit?: string; response: QuestionResponse | null; onChange: (r: QuestionResponse) => void; disabled?: boolean }) {
  const { colors: c, type } = useTheme();
  const [raw, setRaw] = useState(response && 'number' in response ? String(response.number).replace('.', ',') : '');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <TextInput
        editable={!disabled}
        value={raw}
        keyboardType="decimal-pad"
        onChangeText={(v) => {
          setRaw(v);
          const n = Number(v.replace(',', '.'));
          if (Number.isFinite(n)) onChange({ number: n });
        }}
        placeholder={t('quiz.fill_placeholder')}
        placeholderTextColor={c.textSecondary}
        accessibilityLabel={t('quiz.fill_placeholder')}
        style={[type('body'), styles.input, { flex: 1, borderColor: c.primary, color: c.textPrimary }]}
      />
      {unit ? <Text variant="label">{unit}</Text> : null}
    </View>
  );
}

function Matching({ left, right, correctPairs, response, onChange }: { left: { id: string; text: string }[]; right: { id: string; text: string }[]; correctPairs?: [string, string][]; response: QuestionResponse | null; onChange: (r: QuestionResponse) => void }) {
  const { colors: c } = useTheme();
  const pairs = response && 'pairs' in response ? response.pairs : [];
  const [active, setActive] = useState<string | null>(null);
  const pairOf = (l: string) => pairs.find((p) => p[0] === l)?.[1];
  const correctOf = (l: string) => correctPairs?.find((p) => p[0] === l)?.[1];
  const pick = (r: string) => {
    if (!active || correctPairs) return;
    const next = pairs.filter((p) => p[0] !== active && p[1] !== r);
    next.push([active, r]);
    onChange({ pairs: next });
    setActive(null);
  };
  const label = (id: string) => right.find((r) => r.id === id)?.text ?? '';
  return (
    <View style={{ gap: space.md }}>
      <Text variant="bodySmall" tone="secondary">
        {t('quiz.matching_hint')}
      </Text>
      {left.map((l) => {
        const chosen = pairOf(l.id);
        const correct = correctOf(l.id);
        const ok = correctPairs ? chosen === correct : undefined;
        return (
          <Pressable
            key={l.id}
            onPress={() => !correctPairs && setActive(active === l.id ? null : l.id)}
            accessibilityRole="button"
            accessibilityLabel={`${l.text}${chosen ? `, ligado a ${label(chosen)}` : ''}`}
            style={[styles.option, { borderColor: active === l.id ? c.primary : ok === false ? c.danger : ok ? c.success : c.border, backgroundColor: c.surface1, flexDirection: 'column', alignItems: 'stretch' }]}
          >
            <RichContent text={l.text} />
            <Text variant="bodySmall" tone={chosen ? 'accent' : 'secondary'}>
              → {chosen ? label(chosen) : '…'}
              {ok === false && correct ? `  (${t('quiz.correct_answer')}: ${label(correct)})` : ''}
            </Text>
          </Pressable>
        );
      })}
      {!correctPairs ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {right.map((r) => {
            const used = pairs.some((p) => p[1] === r.id);
            return (
              <Pressable
                key={r.id}
                onPress={() => pick(r.id)}
                accessibilityRole="button"
                accessibilityLabel={r.text}
                style={[styles.matchChip, { borderColor: active ? c.primary : c.border, backgroundColor: used ? c.surface2 : c.bg, opacity: used ? 0.6 : 1 }]}
              >
                <Text variant="bodySmall">{r.text}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function Ordering({ items, correct, response, onChange, seed }: { items: { id: string; text: string }[]; correct?: string[]; response: QuestionResponse | null; onChange: (r: QuestionResponse) => void; seed: string }) {
  const { colors: c } = useTheme();
  const initial = useMemo(() => seededShuffle(items, seed).map((i) => i.id), [items, seed]);
  const order = response && 'order' in response && response.order.length ? response.order : initial;
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...order];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    onChange({ order: next });
  };
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="bodySmall" tone="secondary">
        {t('quiz.ordering_hint')}
      </Text>
      {order.map((id, idx) => {
        const item = items.find((i) => i.id === id);
        const ok = correct ? correct[idx] === id : undefined;
        return (
          <View key={id} style={[styles.option, { borderColor: ok === false ? c.danger : ok ? c.success : c.border, backgroundColor: c.surface1 }]}>
            <Text variant="label" tone="secondary">
              {idx + 1}.
            </Text>
            <View style={{ flex: 1 }}>
              <RichContent text={item?.text ?? id} />
            </View>
            {!correct ? (
              <>
                <IconButton icon="chevron-up" label={`Subir ${item?.text ?? ''}`} onPress={() => move(idx, -1)} disabled={idx === 0} size={20} />
                <IconButton icon="chevron-down" label={`Descer ${item?.text ?? ''}`} onPress={() => move(idx, 1)} disabled={idx === order.length - 1} size={20} />
              </>
            ) : null}
          </View>
        );
      })}
      {correct && order.join() !== correct.join() ? (
        <Text variant="bodySmall" tone="secondary">
          {t('quiz.correct_answer')}: {correct.map((id) => items.find((i) => i.id === id)?.text ?? id).join(' → ')}
        </Text>
      ) : null}
    </View>
  );
}

function ShortAnswer({ response, onChange, disabled, long }: { response: QuestionResponse | null; onChange: (r: QuestionResponse) => void; disabled?: boolean; long?: boolean }) {
  const { colors: c, type } = useTheme();
  const text = response && 'text' in response ? response.text : '';
  return (
    <TextInput
      editable={!disabled}
      multiline
      value={text}
      onChangeText={(v) => onChange({ text: v })}
      placeholder={t('quiz.short_placeholder')}
      placeholderTextColor={c.textSecondary}
      accessibilityLabel={t('quiz.short_placeholder')}
      maxLength={long ? 20000 : 4000}
      style={[type('body'), styles.input, { minHeight: long ? 220 : 120, textAlignVertical: 'top', borderColor: c.primary, color: c.textPrimary }]}
    />
  );
}

const styles = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, overflow: 'hidden' },
  letter: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: touch.min },
  matchChip: { borderWidth: 1.5, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 40, justifyContent: 'center' },
  distBar: { position: 'absolute', left: 0, top: 0, bottom: 0 },
});
