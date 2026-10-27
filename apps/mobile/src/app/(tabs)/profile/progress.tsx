import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { supabase } from '../../../api/supabase';
import { Card, ProgressBar, Row, Screen, Section, Stat, Text } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { rows } from '../../../features/common/query';
import { addDays, toLocalDate } from '../../../features/common/format';
import { useMotivation } from '../../../features/motivation/api';
import { t } from '../../../i18n';
import { radius, space, useTheme } from '../../../theme';

// spec 13 §8.5 achievement catalog (names from copy-pt-br §4.17).
const ACHIEVEMENTS: { key: string; name: string }[] = [
  { key: 'first_material', name: 'Primeiro material' },
  { key: 'first_review', name: 'Primeira revisão' },
  { key: 'streak_7', name: '7 dias' },
  { key: 'streak_30', name: '30 dias' },
  { key: 'streak_100', name: '100 dias' },
  { key: 'cards_100', name: '100 cartões' },
  { key: 'cards_1000', name: '1.000 cartões' },
  { key: 'questions_500', name: '500 questões' },
  { key: 'first_mock', name: 'Primeiro simulado' },
  { key: 'clean_notebook', name: 'Caderno limpo' },
  { key: 'calibrated', name: 'Calibrado(a)' },
  { key: 'duelist', name: 'Duelista' },
  { key: 'rematch', name: 'Revanche!' },
  { key: 'bug_hunter', name: 'Caçador de erros' },
  { key: 'week_won', name: 'Semana vencida' },
  { key: 'consistent_week', name: 'Semana consistente' },
];

/** S-PERF-03 Progresso (MOT-01): level, XP, streak calendar, achievements. No comparisons. */
export default function Progress() {
  const { userId } = useSession();
  const m = useMotivation();
  const { colors } = useTheme();
  const from = toLocalDate(addDays(new Date(), -34));
  const days = useQuery({
    queryKey: ['dailyActivity', userId, from],
    enabled: !!userId,
    queryFn: () => rows<{ local_date: string; active_minutes: number; counted: boolean | null }>(supabase.from('daily_activity').select('local_date,active_minutes,counted').eq('user_id', userId!).gte('local_date', from)).catch(() => []),
  });
  const unlocked = useQuery({
    queryKey: ['achievements', userId],
    enabled: !!userId,
    queryFn: () => rows<{ code: string }>(supabase.from('achievements').select('code').eq('user_id', userId!).not('unlocked_at', 'is', null)).catch(() => []),
  });
  const xp = m.data?.xp ?? 0;
  const level = m.data?.level ?? 1;
  let base = 0;
  for (let l = 1; l < level; l++) base += 100 * l;
  const need = 100 * level;
  const active = new Set((days.data ?? []).filter((d) => d.active_minutes > 0).map((d) => d.local_date));
  const have = new Set((unlocked.data ?? []).map((a) => a.code));

  return (
    <Screen title={t('progress.title')}>
      <Card>
        <Row>
          <Stat value={t('progress.level', { n: level })} label={`${xp} XP`} />
          <Stat value={String(m.data?.streak ?? 0)} label={t('streak.count', { n: m.data?.streak ?? 0 }).split(':')[0] ?? ''} />
          <Stat value={String(m.data?.shields ?? 0)} label="🛡️" />
        </Row>
        <ProgressBar value={(xp - base) / need} label={t('progress.xp_to_next', { n: Math.max(0, base + need - xp) })} />
        <Text variant="bodySmall" tone="secondary">
          {t('progress.xp_to_next', { n: Math.max(0, base + need - xp) })}
        </Text>
      </Card>
      <Section title={t('progress.streak_calendar')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {Array.from({ length: 35 }, (_, i) => {
            const d = toLocalDate(addDays(new Date(), i - 34));
            const on = active.has(d);
            return <View key={d} accessibilityLabel={`${d}: ${on ? 'estudou' : 'sem estudo'}`} style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: on ? colors.primary : colors.surface2 }} />;
          })}
        </View>
      </Section>
      <Section title={t('progress.achievements')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {ACHIEVEMENTS.map((a) => {
            const got = have.has(a.key);
            return (
              <View key={a.key} style={{ width: '30%', padding: space.sm, borderRadius: radius.md, backgroundColor: got ? colors.primarySoft : colors.surface1, opacity: got ? 1 : 0.5 }} accessibilityLabel={`${a.name}${got ? '' : `. ${t('progress.locked')}`}`}>
                <Text variant="bodySmall" align="center">{`${got ? '🏆' : '🔒'}\n${a.name}`}</Text>
              </View>
            );
          })}
        </View>
      </Section>
    </Screen>
  );
}
