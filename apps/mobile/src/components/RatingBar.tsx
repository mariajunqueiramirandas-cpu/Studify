import { StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { longInterval, shortInterval } from '../features/common/format';
import { depth, radius, shade, space, useTheme } from '../theme';
import { Tactile } from './Tactile';
import { Text } from './Text';

export type Rating = 1 | 2 | 3 | 4;

interface RatingBarProps {
  /** Next interval in ms per rating (ts-fsrs preview), shown under each label (ux §5.1). */
  intervals?: Partial<Record<Rating, number>>;
  onRate: (r: Rating) => void;
  /** Feed / widget variant: Errei · Lembrei (Again / Good). */
  twoButton?: boolean;
  disabled?: boolean;
}

export function RatingBar({ intervals, onRate, twoButton, disabled }: RatingBarProps) {
  const { colors: c } = useTheme();
  const all: { r: Rating; label: string; color: string }[] = [
    { r: 1, label: t('review.rating.again'), color: c.danger },
    { r: 2, label: t('review.rating.hard'), color: c.warning },
    { r: 3, label: t('review.rating.good'), color: c.success },
    { r: 4, label: t('review.rating.easy'), color: c.info },
  ];
  const buttons = twoButton ? [all[0]!, { ...all[2]!, label: t('review.rating.remembered') }] : all;
  return (
    <View style={styles.row}>
      {buttons.map(({ r, label, color }) => {
        const ms = intervals?.[r];
        return (
          <Tactile
            key={r}
            disabled={disabled}
            onPress={() => onRate(r)}
            accessibilityLabel={ms != null ? t('review.rating_a11y', { label, interval: longInterval(ms) }) : label}
            color={color}
            ledge={shade(color, 0.3)}
            depth={depth.md}
            radius={radius.lg}
            style={styles.btn}
          >
            <Text variant="label" weight="bold" style={{ color: c.onPrimary }}>
              {label}
            </Text>
            {ms != null ? (
              <Text variant="bodySmall" style={{ color: c.onPrimary }}>
                {shortInterval(ms)}
              </Text>
            ) : null}
          </Tactile>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  btn: { flex: 1, minHeight: 68, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm, gap: 2 },
});
