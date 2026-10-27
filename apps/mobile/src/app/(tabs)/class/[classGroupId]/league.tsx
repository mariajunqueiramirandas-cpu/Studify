import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Card, EmptyState, Row, Screen, Section, SkeletonList, SwitchRow, Text, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { updateMyMembership, useClassGroup } from '../../../../features/class/api';
import { useLeagueBoard, useMyLeagueWeeks } from '../../../../features/class/turma5';
import { weekdayDate } from '../../../../features/common/format';
import { t } from '../../../../i18n';
import { useTheme } from '../../../../theme';

const BADGE_ICON: Record<string, string> = { podium_1: '🥇', podium_2: '🥈', podium_3: '🥉', consistent_week: '🌱' };

/**
 * SOC-08 Liga da turma (opt-in): top 10 and your own place, never lower positions of others, no demotion. Night
 * study (quiet hours) does not count, and each day counts at most 500 XP.
 */
export default function League() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const cg = useClassGroup(classGroupId);
  const { userId } = useSession();
  const overlay = useOverlay();
  const { colors: c } = useTheme();
  const optedIn = !!cg.data?.me?.league_opt_in;
  const board = useLeagueBoard(classGroupId, optedIn);
  const weeks = useMyLeagueWeeks(classGroupId);

  return (
    <Screen title={t('league.title')} onBack={() => router.back()} onRefresh={board.refetch} refreshing={board.isRefetching}>
      <SwitchRow
        label={t('league.opt_in')}
        hint={t('league.opt_in_hint')}
        value={optedIn}
        onChange={(v) =>
          void updateMyMembership(classGroupId, userId!, { league_opt_in: v })
            .then(() => cg.refetch())
            .catch(() => overlay.snack(t('error.generic')))
        }
      />
      {!optedIn ? <Banner kind="neutral" message={t('league.off')} /> : null}
      {optedIn ? (
        <Section title={t('league.week')}>
          {board.isLoading ? <SkeletonList rows={4} /> : null}
          {!board.isLoading && (board.data ?? []).length === 0 ? <EmptyState icon="trophy-outline" message={t('league.empty')} /> : null}
          {(board.data ?? []).map((r) => (
            <Card key={r.user_id} tone={r.is_me ? 'soft' : 'default'}>
              <Row>
                <Text variant="heading" style={{ width: 36 }}>
                  {r.rank}º
                </Text>
                <Text style={{ flex: 1 }}>{r.is_me ? t('league.you') : r.nickname}</Text>
                <Text variant="label" style={{ color: c.primary }}>
                  {t('league.xp', { n: r.league_xp })}
                </Text>
              </Row>
            </Card>
          ))}
          <Text variant="caption" tone="secondary">
            {t('league.rules')}
          </Text>
        </Section>
      ) : null}
      {(weeks.data ?? []).length ? (
        <Section title={t('league.history')}>
          {(weeks.data ?? []).map((w) => (
            <Row key={w.week_start}>
              <Text variant="bodySmall" style={{ flex: 1 }}>
                {t('league.week_of', { date: weekdayDate(w.week_start) })}
              </Text>
              <Text variant="bodySmall">{w.badges.map((b) => BADGE_ICON[b] ?? '🏅').join(' ')}</Text>
              <Text variant="bodySmall" tone="secondary">
                {w.rank ? `${w.rank}º · ` : ''}
                {t('league.xp', { n: w.league_xp })}
              </Text>
            </Row>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
