import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { BottomSheet, Button, Card, ListItem, Pill, RadioList, Screen, Section, TextField, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { blockUser, moderateMember, reportAbuse, useClassGroup, useMembers, type MemberPublic } from '../../../../features/class/api';
import { options, t } from '../../../../i18n';

const REPORT_REASONS = ['harassment', 'inappropriate', 'offensive_name', 'spam', 'other'] as const;

/** S-TUR-07 Membros: roles, pending requests, member menu (SOC-01.5, SOC-01.8, SP-09). */
export default function Members() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const { userId } = useSession();
  const cg = useClassGroup(classGroupId);
  const members = useMembers(classGroupId);
  const overlay = useOverlay();
  const [menu, setMenu] = useState<MemberPublic | null>(null);
  const [report, setReport] = useState<MemberPublic | null>(null);
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number] | null>(null);
  const [comment, setComment] = useState('');
  const isMod = !!cg.data?.isMod;
  const pending = (members.data ?? []).filter((m) => m.status === 'pending');
  const active = (members.data ?? []).filter((m) => m.status === 'active');
  const reasonLabels = options('report.reasons');
  const name = (m: MemberPublic) => m.nickname ?? m.display_name ?? '—';

  const act = async (fn: () => Promise<unknown>, done = t('global.done')) => {
    try {
      await fn();
      overlay.snack(done);
      void members.refetch();
    } catch {
      overlay.snack(t('error.permission'));
    }
  };

  return (
    <Screen title={t('class.members')} onRefresh={members.refetch} refreshing={members.isRefetching}>
      {isMod && pending.length ? (
        <Section title={t('class.requests', { n: pending.length }).split(' · ')[0]} action={<Button compact variant="tonal" label={t('class.approve_all')} onPress={() => act(() => Promise.all(pending.map((m) => moderateMember(classGroupId, m.user_id, 'approve'))))} />}>
          {pending.map((m) => (
            <Card key={m.user_id}>
              <ListItem
                title={name(m)}
                right={
                  <>
                    <Button compact variant="text" label={t('class.decline')} onPress={() => act(() => moderateMember(classGroupId, m.user_id, 'reject'))} />
                    <Button compact label={t('class.approve')} onPress={() => act(() => moderateMember(classGroupId, m.user_id, 'approve'))} />
                  </>
                }
              />
            </Card>
          ))}
        </Section>
      ) : null}
      <Section title={`${t('class.members')} (${active.length})`}>
        {active.map((m) => (
          <ListItem
            key={m.user_id}
            icon="person-circle-outline"
            title={m.user_id === userId ? `${name(m)} (${t('duel.you')})` : name(m)}
            right={m.role !== 'member' ? <Pill text={t(`class.roles.${m.role}`)} /> : undefined}
            onPress={m.user_id !== userId ? () => setMenu(m) : undefined}
          />
        ))}
      </Section>
      <BottomSheet visible={!!menu} onClose={() => setMenu(null)} title={menu ? name(menu) : ''}>
        <ListItem icon="flash-outline" title={t('duel.challenge')} onPress={() => (setMenu(null), router.push({ pathname: '/class/[classGroupId]/duel-new', params: { classGroupId, opponentId: menu!.user_id } }))} />
        <ListItem icon="alert-circle-outline" title={t('report.title')} onPress={() => (setReport(menu), setMenu(null))} />
        <ListItem
          icon="hand-left-outline"
          title={t('class.block')}
          onPress={async () => {
            const m = menu!;
            setMenu(null);
            await act(() => blockUser(m.user_id), t('block.done', { name: name(m) }));
          }}
        />
        {isMod && menu?.role === 'member' ? <ListItem icon="shield-checkmark-outline" title={t('class.make_moderator')} onPress={() => (setMenu(null), void act(() => moderateMember(classGroupId, menu!.user_id, 'promote')))} /> : null}
        {cg.data?.me?.role === 'owner' && menu?.role === 'moderator' ? <ListItem icon="shield-outline" title={t('class.remove_moderator')} onPress={() => (setMenu(null), void act(() => moderateMember(classGroupId, menu!.user_id, 'demote')))} /> : null}
        {isMod && menu?.role !== 'owner' ? (
          <ListItem
            icon="exit-outline"
            destructive
            title={t('class.remove_member')}
            onPress={async () => {
              const m = menu!;
              setMenu(null);
              if (await overlay.confirm({ title: t('class.remove_member'), message: name(m), destructive: true })) await act(() => moderateMember(classGroupId, m.user_id, 'remove'));
            }}
          />
        ) : null}
      </BottomSheet>
      <BottomSheet
        visible={!!report}
        onClose={() => setReport(null)}
        title={t('report.title')}
        footer={
          <Button
            label={t('flag.send')}
            disabled={!reason}
            onPress={async () => {
              const m = report!;
              setReport(null);
              await act(() => reportAbuse({ reported_id: m.user_id, class_group_id: classGroupId, reason: reason!, comment: comment.trim() || undefined }), t('report.sent'));
              setReason(null);
              setComment('');
            }}
          />
        }
      >
        <RadioList value={reason} onChange={setReason} options={REPORT_REASONS.map((r, i) => ({ value: r, label: reasonLabels[i] ?? r }))} />
        <TextField label={t('flag.comment')} value={comment} onChangeText={setComment} multiline maxLength={500} />
      </BottomSheet>
    </Screen>
  );
}
