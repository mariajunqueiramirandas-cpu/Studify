import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Card, IconTile, ListItem, Screen, Section, Tactile, Text, type IconName, type IconTone } from '../../../components';
import { useLive } from '../../../db/hooks';
import { dueCount } from '../../../features/memory/local';
import { useMistakes } from '../../../features/practice/api';
import { t } from '../../../i18n';
import { FONTS, radius, shade, space, useTheme } from '../../../theme';

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
        <Mode icon="help-circle-outline" title={t('practice_hub.quiz')} hint={t('practice_hub.quiz_hint')} onPress={() => router.push('/practice/quiz/new')} />
        <Mode icon="timer-outline" tone="lamp" title={t('practice_hub.mock')} hint={t('practice_hub.mock_hint')} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mock_exam' } })} />
        <Mode icon="camera-outline" tone="lagoon" title={t('cam.title')} hint={t('cam.practice_hint')} onPress={() => router.push('/camera')} />
        <Mode icon="create-outline" tone="success" title={t('essay.entry')} hint={t('essay.entry_hint')} onPress={() => router.push('/essay/new')} />
      </View>
      <Card>
        <ListItem icon="refresh-outline" tone="danger" title={t('mistakes.retry')} subtitle={open ? `${open}` : undefined} disabled={!open} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mistake_retry' } })} />
        <ListItem icon="book-outline" tone="danger" title={t('mistakes.title')} onPress={() => router.push('/practice/mistakes')} />
      </Card>
      <Section title={t('practice_hub.more')}>
        <Card>
          <ListItem icon="chatbubbles-outline" title={t('tutor.threads')} onPress={() => router.push('/practice/tutor')} />
          <ListItem icon="albums-outline" tone="lamp" title={t('feed.title')} onPress={() => router.push('/feed')} />
          <ListItem icon="sparkles-outline" tone="lagoon" title={t('memory_map.title')} onPress={() => router.push('/practice/memory-map')} />
          <ListItem icon="speedometer-outline" tone="success" title={t('calibration.title')} onPress={() => router.push('/practice/calibration')} />
        </Card>
      </Section>
    </Screen>
  );
}

/** Today's flashcards as a little stack of index cards: the front one is ruled under its header like the real thing. */
function Deck({ due }: { due: number }) {
  const { colors: c, easyReading } = useTheme();
  return (
    <View style={styles.deck}>
      <View style={[styles.under, styles.under2, { backgroundColor: c.surface2, borderColor: c.border }]} />
      <View style={[styles.under, styles.under1, { backgroundColor: c.surface1, borderColor: c.border }]} />
      <View style={[styles.front, { backgroundColor: c.surface1, borderColor: c.border, borderBottomColor: shade(c.border, 0.14) }]}>
        <View style={[styles.cardHead, due ? { borderBottomColor: c.lagoon, borderBottomWidth: 2, paddingBottom: space.md } : null]}>
          <IconTile icon={due ? 'flash-outline' : 'checkmark-done-outline'} tone={due ? 'primary' : 'success'} size={44} />
          <View style={{ flex: 1 }}>
            {due ? (
              <>
                <Text variant="display" style={easyReading ? undefined : { fontFamily: FONTS.display }}>
                  {due}
                </Text>
                <Text tone="secondary">{t('practice_hub.deck_label', { count: due })}</Text>
              </>
            ) : (
              <Text variant="title">{t('review.all_done')}</Text>
            )}
          </View>
          {due ? (
            <Text variant="bodySmall" tone="secondary" style={{ alignSelf: 'flex-start' }}>
              {t('practice_hub.deck_minutes', { n: Math.max(1, Math.round((due * 8) / 60)) })}
            </Text>
          ) : null}
        </View>
        {due ? <Button label={t('review.start')} icon="play" onPress={() => router.push('/review')} /> : null}
      </View>
    </View>
  );
}

function Mode({ icon, tone = 'primary', title, hint, onPress }: { icon: IconName; tone?: IconTone; title: string; hint?: string; onPress: () => void }) {
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
      <IconTile icon={icon} tone={tone} size={44} />
      <View style={{ gap: space.xxs }}>
        <Text variant="label" weight="bold" numberOfLines={2}>
          {title}
        </Text>
        {hint ? (
          <Text variant="bodySmall" tone="secondary" numberOfLines={3}>
            {hint}
          </Text>
        ) : null}
      </View>
    </Tactile>
  );
}

const styles = StyleSheet.create({
  deck: { marginBottom: space.md },
  // The cards underneath peek out below the front one, each a little narrower.
  under: { position: 'absolute', top: 0, borderRadius: radius.xl, borderWidth: 2 },
  under1: { left: space.sm, right: space.sm, bottom: -space.sm },
  under2: { left: space.lg, right: space.lg, bottom: -space.lg },
  front: { borderRadius: radius.xl, borderWidth: 2, borderBottomWidth: 6, padding: space.lg, gap: space.lg },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  mode: { width: '48.3%', minHeight: 148, padding: space.lg, justifyContent: 'space-between', gap: space.md },
});
