import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Card, ListItem, Screen, Section, Tactile, Text, type IconName } from '../../../components';
import { useLive } from '../../../db/hooks';
import { dueCount } from '../../../features/memory/local';
import { useMistakes } from '../../../features/practice/api';
import { t } from '../../../i18n';
import { radius, shade, space, useTheme } from '../../../theme';

/** S-PRA-01 Praticar hub: today's deck on top, the ways to practise below it. */
export default function PracticeHub() {
  const due = useLive((d) => dueCount(d), { tables: ['card_states', 'cards'] });
  const mistakes = useMistakes('open');
  const open = mistakes.data?.length ?? 0;
  const n = due.data ?? 0;
  return (
    <Screen title={t('tab.practice')} root largeTitle>
      <Deck due={n} />
      <View style={styles.grid}>
        <Mode icon="help-circle-outline" title="Fazer quiz" onPress={() => router.push('/practice/quiz/new')} />
        <Mode icon="timer-outline" title="Simulado" onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mock_exam' } })} />
        <Mode icon="camera-outline" title={t('cam.title')} hint={t('cam.practice_hint')} onPress={() => router.push('/camera')} />
        <Mode icon="create-outline" title={t('essay.entry')} hint={t('essay.entry_hint')} onPress={() => router.push('/essay/new')} />
      </View>
      <Card>
        <ListItem icon="refresh-outline" title={t('mistakes.retry')} subtitle={open ? `${open}` : undefined} disabled={!open} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mistake_retry' } })} />
        <ListItem icon="book-outline" title={t('mistakes.title')} onPress={() => router.push('/practice/mistakes')} />
      </Card>
      <Section title="Mais">
        <Card>
          <ListItem icon="chatbubbles-outline" title={t('tutor.threads')} onPress={() => router.push('/practice/tutor')} />
          <ListItem icon="albums-outline" title={t('feed.title')} onPress={() => router.push('/feed')} />
          <ListItem icon="sparkles-outline" title={t('memory_map.title')} onPress={() => router.push('/practice/memory-map')} />
          <ListItem icon="speedometer-outline" title={t('calibration.title')} onPress={() => router.push('/practice/calibration')} />
        </Card>
      </Section>
    </Screen>
  );
}

/** Today's flashcards as a little stack of index cards. */
function Deck({ due }: { due: number }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.deck}>
      <View style={[styles.under, { backgroundColor: c.surface2, borderColor: c.border, transform: [{ rotate: '-3deg' }, { translateY: 8 }] }]} />
      <View style={[styles.under, { backgroundColor: c.surface1, borderColor: c.border, transform: [{ rotate: '1.5deg' }, { translateY: 4 }] }]} />
      <View style={[styles.front, { backgroundColor: c.surface1, borderColor: c.border, borderBottomColor: shade(c.border, 0.14) }]}>
        <Text variant="title">{due ? t('today.reviews_due', { n: due }) : t('review.all_done')}</Text>
        {due ? <Button label={t('review.start')} icon="flash-outline" onPress={() => router.push('/review')} /> : null}
      </View>
    </View>
  );
}

function Mode({ icon, title, hint, onPress }: { icon: IconName; title: string; hint?: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  return (
    <Tactile
      onPress={onPress}
      accessibilityLabel={hint ? `${title}. ${hint}` : title}
      color={c.surface1}
      borderColor={c.border}
      ledge={shade(c.border, 0.14)}
      borderWidth={2}
      style={styles.mode}
      pressedStyle={{ backgroundColor: c.surface2 }}
    >
      <Ionicons name={icon} size={26} color={c.primary} />
      <Text variant="label" numberOfLines={2}>
        {title}
      </Text>
    </Tactile>
  );
}

const styles = StyleSheet.create({
  deck: { marginBottom: space.md },
  under: { position: 'absolute', left: 6, right: 6, top: 0, bottom: 0, borderRadius: radius.xl, borderWidth: 2 },
  front: { borderRadius: radius.xl, borderWidth: 2, borderBottomWidth: 6, padding: space.xl, paddingTop: space.xl + space.sm, gap: space.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  mode: { width: '48.3%', minHeight: 108, padding: space.lg, justifyContent: 'space-between', gap: space.sm },
});
