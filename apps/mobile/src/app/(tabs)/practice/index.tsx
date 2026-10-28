import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Card, ListItem, Screen, Section, Text, type IconName } from '../../../components';
import { useLive } from '../../../db/hooks';
import { dueCount } from '../../../features/memory/local';
import { useMistakes } from '../../../features/practice/api';
import { t } from '../../../i18n';
import { radius, space, useTheme } from '../../../theme';

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
      <View style={[styles.front, { backgroundColor: c.surface1, borderColor: c.border }]}>
        <View style={[styles.rule, { backgroundColor: c.danger }]} />
        <Text variant="title">{due ? t('today.reviews_due', { n: due }) : t('review.all_done')}</Text>
        {due ? <Button label={t('review.start')} icon="flash-outline" onPress={() => router.push('/review')} /> : null}
      </View>
    </View>
  );
}

function Mode({ icon, title, hint, onPress }: { icon: IconName; title: string; hint?: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${title}. ${hint}` : title}
      style={({ pressed }) => [styles.mode, { backgroundColor: pressed ? c.surface2 : c.surface1, borderColor: c.border }]}
    >
      <Ionicons name={icon} size={26} color={c.primary} />
      <Text variant="label" numberOfLines={2}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  deck: { marginBottom: space.md },
  under: { position: 'absolute', left: 6, right: 6, top: 0, bottom: 0, borderRadius: radius.lg, borderWidth: 1 },
  front: { borderRadius: radius.lg, borderWidth: 1, padding: space.xl, paddingTop: space.xl + space.sm, gap: space.lg },
  rule: { position: 'absolute', top: space.lg, left: 0, right: 0, height: 1.5, opacity: 0.45 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  mode: { width: '48.3%', minHeight: 104, borderRadius: radius.lg, borderWidth: 1, padding: space.lg, justifyContent: 'space-between', gap: space.sm },
});
