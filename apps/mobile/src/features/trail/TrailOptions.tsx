import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { RichContent, Tactile, Text } from '../../components';
import { t } from '../../i18n';
import { depth, radius, shade, space, useTheme } from '../../theme';

export interface TrailReveal {
  correct: string;
  picked: string | null;
  rationales: { id: string; rationale: string }[];
}

/**
 * The alternatives of a Trilha question. Before the answer: pick one. After it: the right one lights up green, a wrong
 * pick shakes and turns red, and every alternative opens to say why it is (or isn't) the answer — the two that matter
 * open on their own, the rest on a tap.
 */
export function TrailOptions({ options, selected, onSelect, reveal }: { options: { id: string; text: string }[]; selected: string | null; onSelect: (id: string) => void; reveal: TrailReveal | null }) {
  const { colors: c } = useTheme();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const others = reveal ? options.filter((o) => o.id !== reveal.correct && o.id !== reveal.picked).length : 0;
  return (
    <View style={{ gap: space.sm }} accessibilityRole={reveal ? undefined : 'radiogroup'}>
      {options.map((o, i) => {
        const key = reveal ? (o.id === reveal.correct || o.id === reveal.picked ? 'auto' : 'manual') : null;
        const open = key ? (toggled[o.id] ?? key === 'auto') : false;
        return (
          <OptionRow
            key={o.id}
            index={i}
            id={o.id}
            text={o.text}
            selected={selected === o.id}
            reveal={reveal}
            open={open}
            onPress={() => (reveal ? setToggled((s) => ({ ...s, [o.id]: !open })) : onSelect(o.id))}
          />
        );
      })}
      {reveal && others > 0 ? (
        <View style={styles.hint}>
          <Ionicons name="information-circle-outline" size={18} color={c.textSecondary} />
          <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
            {t('trail.why_tap')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function OptionRow({ index, id, text, selected, reveal, open, onPress }: { index: number; id: string; text: string; selected: boolean; reveal: TrailReveal | null; open: boolean; onPress: () => void }) {
  const { colors: c, reduceMotion } = useTheme();
  const [enter] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  const [shake] = useState(() => new Animated.Value(0));
  const [pop] = useState(() => new Animated.Value(1));
  const isCorrect = !!reveal && reveal.correct === id;
  const isWrongPick = !!reveal && reveal.picked === id && !isCorrect;

  useEffect(() => {
    if (reduceMotion) return;
    Animated.timing(enter, { toValue: 1, duration: 260, delay: index * 60, useNativeDriver: true }).start();
  }, [enter, index, reduceMotion]);

  useEffect(() => {
    if (reduceMotion || !reveal) return;
    if (isWrongPick) {
      Animated.sequence([10, -9, 7, -5, 3, 0].map((x) => Animated.timing(shake, { toValue: x, duration: 55, useNativeDriver: true }))).start();
    } else if (isCorrect) {
      Animated.sequence([
        Animated.timing(pop, { toValue: 1.035, duration: 140, useNativeDriver: true }),
        Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: true }),
      ]).start();
    }
  }, [reveal, isWrongPick, isCorrect, shake, pop, reduceMotion]);

  const ink = isCorrect ? c.success : isWrongPick ? c.danger : selected && !reveal ? c.primary : c.border;
  const face = isCorrect ? c.successSoft : isWrongPick ? c.dangerSoft : selected && !reveal ? c.primarySoft : c.surface1;
  const filled = isCorrect || isWrongPick || (selected && !reveal);
  const dim = !!reveal && !isCorrect && !isWrongPick && !open;
  const rationale = reveal?.rationales.find((r) => r.id === id)?.rationale;
  const why = isCorrect ? t('trail.why_right') : t('trail.why_wrong');
  const label = `${id}. ${text}${isCorrect ? `. ${t('quiz.correct_answer')}` : ''}`;

  return (
    <Animated.View
      style={{
        opacity: Animated.multiply(enter, dim ? 0.62 : 1),
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }, { translateX: shake }, { scale: pop }],
      }}
    >
      <Tactile
        onPress={onPress}
        accessibilityRole={reveal ? 'button' : 'radio'}
        accessibilityState={reveal ? { expanded: open } : { selected, checked: selected }}
        accessibilityLabel={label}
        accessibilityHint={reveal && rationale ? why : undefined}
        color={face}
        borderColor={ink}
        ledge={shade(ink, filled ? 0.2 : 0.12)}
        borderWidth={2}
        depth={depth.md}
        style={styles.option}
      >
        <View style={styles.row}>
          <View style={[styles.letter, { backgroundColor: filled ? ink : 'transparent', borderColor: filled ? ink : c.border }]}>
            {isCorrect || isWrongPick ? (
              <Ionicons name={isCorrect ? 'checkmark' : 'close'} size={20} color={c.onPrimary} />
            ) : (
              <Text variant="label" weight="bold" style={{ color: filled ? c.onPrimary : c.textPrimary }}>
                {id}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <RichContent text={text} />
          </View>
          {reveal && rationale ? (
            <View style={styles.more}>
              {!isCorrect && !isWrongPick && !open ? (
                <Text variant="bodySmall" tone="secondary">
                  {t('trail.why_other')}
                </Text>
              ) : null}
              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={isCorrect || isWrongPick ? ink : c.textSecondary} />
            </View>
          ) : null}
        </View>
        {open && rationale ? (
          <View style={[styles.why, { borderTopColor: isCorrect || isWrongPick ? `${ink}55` : c.border }]}>
            <Text variant="label" style={{ color: isCorrect ? c.success : isWrongPick ? c.danger : c.textSecondary }}>
              {why}
            </Text>
            <RichContent variant="reading" text={rationale} />
          </View>
        ) : null}
      </Tactile>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  option: { paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 64, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  letter: { width: 36, height: 36, borderRadius: radius.md, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  more: { flexDirection: 'row', alignItems: 'center', gap: space.xxs },
  why: { marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, gap: space.xs },
  hint: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs },
});
