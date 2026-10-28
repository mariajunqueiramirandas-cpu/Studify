import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { View } from 'react-native';
import { Button, Card, ProgressBar, Text } from '../../components';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';
import { useTrailSummary } from './api';

/** The Trilha's entry on the subject home (TRL-01.1): first and largest, so the guided path is the default way in. */
export function TrailCard({ subjectId, tint }: { subjectId: string; tint: string }) {
  const { colors: c } = useTheme();
  const summary = useTrailSummary(subjectId);
  const s = summary.data;
  const open = () => router.push({ pathname: '/trail/[subjectId]', params: { subjectId } });
  const done = s?.status === 'completed';
  const total = s?.chapterCount ?? 0;
  return (
    <Card tone="soft" onPress={open} accessibilityLabel={t('trail.title')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={done ? 'trophy' : 'trail-sign'} size={26} color={c.onPrimary} />
        </View>
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text variant="heading">{s ? t('trail.title') : t('trail.entry_new_title')}</Text>
          <Text variant="bodySmall" tone="secondary">
            {done ? t('trail.entry_done') : s && total ? t('trail.entry_progress', { i: Math.min(s.chapterIndex + 1, total), n: total }) : t('trail.entry_new_body')}
          </Text>
        </View>
      </View>
      {s && total ? <ProgressBar value={done ? 1 : s.chapterIndex / total} color={tint} height={8} /> : null}
      <Button label={done ? t('trail.entry_review') : s ? t('trail.entry_continue') : t('trail.entry_start')} icon={done ? 'map-outline' : 'play'} onPress={open} />
    </Card>
  );
}
