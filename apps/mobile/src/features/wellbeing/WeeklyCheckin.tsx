// WEL-03.4: once a week, "Como você tá com os estudos?" with 5 faces. The answer stays on the phone; two lowest
// answers in a row bring a supportive message and the help card.
import { parseProfileSettings } from '@studify/shared';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Card, Row, Text } from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
import { useSession } from '../auth/session';
import { answeredThisWeek, CHECKIN_FACES, checkinMoods, saveCheckin } from './checkin';
import { HelpCard } from './HelpCard';

export function WeeklyCheckin() {
  const db = useDb();
  const { profile } = useSession();
  const { colors } = useTheme();
  const [done, setDone] = useState(() => answeredThisWeek(db));
  const [low, setLow] = useState(false);
  let enabled = false;
  try {
    enabled = !!parseProfileSettings(profile?.settings).checkin_enabled;
  } catch {
    enabled = false;
  }
  if (low) {
    return (
      <>
        <Card tone="soft">
          <Text>{t('burnout.checkin_low')}</Text>
        </Card>
        <HelpCard />
      </>
    );
  }
  if (!enabled || done) return null;

  const answer = (mood: number) => {
    saveCheckin(db, mood);
    const moods = checkinMoods(db);
    setLow(moods.length >= 2 && moods[moods.length - 1] === 1 && moods[moods.length - 2] === 1);
    setDone(true);
  };

  return (
    <Card>
      <Text variant="heading">{t('checkin.question')}</Text>
      <Row style={{ justifyContent: 'space-between' }}>
        {CHECKIN_FACES.map((face, i) => (
          <Pressable
            key={face}
            onPress={() => answer(i + 1)}
            accessibilityRole="button"
            accessibilityLabel={t(`checkin.faces.${i + 1}`)}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.surface2 }}
          >
            <Text style={{ fontSize: 28 }}>{face}</Text>
          </Pressable>
        ))}
      </Row>
      <View style={{ paddingTop: space.xs }}>
        <Text variant="caption" tone="secondary">
          {t('checkin.private')}
        </Text>
      </View>
    </Card>
  );
}
