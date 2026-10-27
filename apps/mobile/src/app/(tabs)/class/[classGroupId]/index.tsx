import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActionBar, Banner, Button, Card, IconButton, ListItem, Row, Screen, Section, SubjectBadge, Text } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { useClassGroup, useClassInsights, useClassSubjects, useDuels, useLiveBattles, useMembers, useReviewQueue } from '../../../../features/class/api';
import { relativeDay } from '../../../../features/common/format';
import { colorKeyFromHex } from '../../../../features/subjects/api';
import { t } from '../../../../i18n';

/** S-TUR-05 {Turma}: shared subjects, "O que a turma mais erra", battle banner, my duels (SOC-01, SOC-04). */
export default function ClassHome() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const { userId } = useSession();
  const cg = useClassGroup(classGroupId);
  const members = useMembers(classGroupId);
  const subjects = useClassSubjects(classGroupId);
  const insights = useClassInsights(classGroupId);
  const duels = useDuels(classGroupId);
  const battles = useLiveBattles(classGroupId);
  const flags = useReviewQueue(cg.data?.isMod ? classGroupId : undefined);
  const g = cg.data?.group;
  const active = (members.data ?? []).filter((m) => m.status === 'active');
  const pending = (members.data ?? []).filter((m) => m.status === 'pending');
  const nameOf = useMemo(() => new Map((members.data ?? []).map((m) => [m.user_id, m.nickname ?? m.display_name ?? '—'])), [members.data]);
  const live = battles.data?.[0];
  const canHost = cg.data?.isMod || g?.settings?.battles_host !== 'owner_mods';

  return (
    <Screen
      title={g?.name ?? ''}
      onRefresh={() => (void cg.refetch(), void members.refetch(), void duels.refetch())}
      refreshing={cg.isRefetching}
      actions={
        <>
          <IconButton icon="person-add-outline" label={t('class.invite.title')} onPress={() => router.push(`/class/${classGroupId}/invite`)} />
          <IconButton icon="settings-outline" label={t('class.settings')} onPress={() => router.push(`/class/${classGroupId}/settings`)} />
        </>
      }
      context={<Text variant="bodySmall" tone="secondary">{t('class.members_count', { n: active.length })}</Text>}
      footer={
        <ActionBar>
          <Row>
            <Button style={{ flex: 1 }} icon="flash-outline" label={t('duel.challenge')} onPress={() => router.push({ pathname: '/class/[classGroupId]/duel-new', params: { classGroupId } })} />
            {canHost ? <Button style={{ flex: 1 }} variant="secondary" icon="trophy-outline" label={t('battle.host_new')} onPress={() => router.push({ pathname: '/battle/new', params: { classGroupId } })} /> : null}
          </Row>
        </ActionBar>
      }
    >
      {live ? <Banner kind="info" icon="flash-outline" message={t('class.battle_banner', { pin: live.pin })} action={{ label: t('class.join_battle'), onPress: () => router.push({ pathname: '/battle/[battleId]', params: { battleId: live.id, pin: live.pin } }) }} /> : null}
      {cg.data?.isMod && pending.length ? <Banner kind="warning" message={t('class.requests', { n: pending.length }).split(' · ')[0]!} action={{ label: t('class.members'), onPress: () => router.push(`/class/${classGroupId}/members`) }} /> : null}
      {cg.data?.isMod && flags.data?.length ? <Banner kind="neutral" icon="flag-outline" message={`${t('class.review_queue')}: ${flags.data.length}`} action={{ label: t('global.see_all'), onPress: () => router.push(`/class/${classGroupId}/review-queue`) }} /> : null}

      <Section title={t('class.shared_subjects')}>
        {(subjects.data ?? []).map((s) => (
          <Card key={s.id} onPress={() => router.push(`/subjects/${s.id}`)}>
            <Row>
              <SubjectBadge color={colorKeyFromHex(s.color)} icon={s.icon} size={36} />
              <Text variant="label">{s.name}</Text>
            </Row>
          </Card>
        ))}
        {subjects.isFetched && !subjects.data?.length ? <Text tone="secondary">{t('subjects.empty')}</Text> : null}
      </Section>

      <Section title={t('class.insight.title')}>
        {!insights.data?.length ? <Text tone="secondary">{t('class.insight.empty')}</Text> : null}
        {(insights.data ?? []).slice(0, 5).map((i, idx) => {
          const trap = i.option_pcts ? Object.entries(i.option_pcts).sort((a, b) => b[1] - a[1])[0] : null;
          return (
            <Card key={`${i.question_id ?? i.node_id}-${idx}`} onPress={i.question_id ? undefined : undefined}>
              <Text variant="label">{t('class.insight.hard')}</Text>
              <Text>{t('class.insight.pct', { p: Math.round(i.pct_wrong * (i.pct_wrong <= 1 ? 100 : 1)) })}</Text>
              {trap ? <Text variant="bodySmall" tone="secondary">{t('class.insight.trap', { p: Math.round(trap[1] * (trap[1] <= 1 ? 100 : 1)), letter: trap[0] })}</Text> : null}
            </Card>
          );
        })}
      </Section>

      <Section title={t('class.my_duels')}>
        {(duels.data ?? []).slice(0, 8).map((d) => {
          const other = d.challenger_id === userId ? d.opponent_id : d.challenger_id;
          const myTurn = d.status === 'waiting_opponent' && d.opponent_id === userId && !d.opponent_attempt_id;
          const label = d.status === 'finished' ? (d.winner_id === userId ? t('duel.win') : d.winner_id ? t('duel.loss') : t('duel.tie')) : d.status === 'expired' || d.status === 'declined' ? t('duel.expired') : myTurn ? t('duel.your_turn') : t('duel.waiting', { name: nameOf.get(other) ?? '' });
          return <ListItem key={d.id} icon="flash-outline" title={nameOf.get(other) ?? '—'} subtitle={`${label} · ${relativeDay(d.created_at)}`} onPress={() => router.push({ pathname: '/duel/[duelId]', params: { duelId: d.id } })} />;
        })}
        {duels.isFetched && !duels.data?.length ? <Text tone="secondary">—</Text> : null}
      </Section>

      <Card>
        <ListItem icon="cafe-outline" title={t('rooms.title')} subtitle={t('rooms.entry_hint')} onPress={() => router.push(`/class/${classGroupId}/rooms`)} />
        <ListItem icon="people-outline" title={t('class.members')} subtitle={String(active.length)} onPress={() => router.push(`/class/${classGroupId}/members`)} />
        {cg.data?.isMod ? <ListItem icon="flag-outline" title={t('class.review_queue')} onPress={() => router.push(`/class/${classGroupId}/review-queue`)} /> : null}
      </Card>
    </Screen>
  );
}
