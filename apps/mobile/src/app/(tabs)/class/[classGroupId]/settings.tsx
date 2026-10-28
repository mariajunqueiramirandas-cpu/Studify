import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Button, Card, RadioList, Screen, Section, SwitchRow, TextField, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { deleteClassGroup, leaveClassGroup, updateClassGroup, updateMyMembership, useClassGroup, type ClassGroup } from '../../../../features/class/api';
import { options, t } from '../../../../i18n';

/** S-TUR-08 Configurações da turma: join policy, hosting, nickname, opt-ins, leave (SOC-01), delete (SOC-01.15). */
export default function ClassSettings() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const { userId } = useSession();
  const cg = useClassGroup(classGroupId);
  const overlay = useOverlay();
  const qc = useQueryClient();
  const g = cg.data?.group;
  const me = cg.data?.me;
  const [nickname, setNickname] = useState('');
  useEffect(() => setNickname(me?.nickname ?? ''), [me?.nickname]);
  const hostLabels = options('class.battle_hosts_options');
  const save = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      void cg.refetch();
    } catch {
      overlay.snack(t('error.permission'));
    }
  };

  return (
    <Screen title={t('class.settings')}>
      <Section title={t('class.nickname')}>
        <TextField value={nickname} onChangeText={setNickname} maxLength={30} accessibilityLabel={t('class.nickname')} onEndEditing={() => save(() => updateMyMembership(classGroupId, userId!, { nickname: nickname.trim() || null }))} />
        <SwitchRow label={t('class.opt_insights')} value={me?.contribute_insights ?? true} onChange={(v) => save(() => updateMyMembership(classGroupId, userId!, { contribute_insights: v }))} />
        <SwitchRow label={t('class.opt_duels')} value={me?.accepts_duels ?? true} onChange={(v) => save(() => updateMyMembership(classGroupId, userId!, { accepts_duels: v }))} />
      </Section>
      {cg.data?.isMod && g ? (
        <Section title={t('class.join_policy')}>
          <RadioList<ClassGroup['join_policy']>
            value={g.join_policy}
            onChange={(v) => save(() => updateClassGroup(classGroupId, { join_policy: v }))}
            options={[
              { value: 'approval', label: t('class.join_policies.approval') },
              { value: 'open', label: t('class.join_policies.open') },
            ]}
          />
          <SwitchRow label={t('class.allow_uploads')} value={g.allow_member_uploads} onChange={(v) => save(() => updateClassGroup(classGroupId, { allow_member_uploads: v }))} />
          <RadioList<'anyone' | 'owner_mods'>
            value={g.settings?.battles_host ?? 'anyone'}
            onChange={(v) => save(() => updateClassGroup(classGroupId, { settings: { ...g.settings, battles_host: v } }))}
            options={[
              { value: 'anyone', label: hostLabels[0] ?? '' },
              { value: 'owner_mods', label: hostLabels[1] ?? '' },
            ]}
          />
        </Section>
      ) : null}
      <Card>
        <Button
          variant="destructive"
          label={t('class.leave_button')}
          onPress={async () => {
            const [title, body] = t('class.leave').split(' · ');
            if (!(await overlay.confirm({ title: title ?? '', message: body, destructive: true, confirmLabel: t('class.leave_button') }))) return;
            try {
              await leaveClassGroup(classGroupId);
              router.replace('/class');
            } catch {
              overlay.snack(t('error.permission'));
            }
          }}
        />
      </Card>
      {cg.data?.me?.role === 'owner' && g ? (
        <Card>
          <Button
            variant="destructive"
            label={t('class.delete')}
            onPress={async () => {
              const confirmed = await overlay.confirm({
                title: t('class.delete'),
                message: `${t('class.delete_warning')} ${t('class.delete_confirm')}`,
                destructive: true,
                confirmLabel: t('class.delete'),
                typedConfirmation: g.name,
              });
              if (!confirmed) return;
              try {
                await deleteClassGroup(classGroupId);
                void qc.invalidateQueries({ queryKey: ['classGroups'] });
                router.replace('/class');
              } catch {
                overlay.snack(t('error.permission'));
              }
            }}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
