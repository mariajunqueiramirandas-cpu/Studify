import { ACHIEVEMENTS, type CapiSlot } from '@studify/shared';
import { View } from 'react-native';
import { Capi, Card, Chip, ChipGroup, Screen, Section, SwitchRow, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { useCapi } from '../../../features/motivation/capi';
import { updateSettings } from '../../../features/profile/api';
import { t } from '../../../i18n';
import { space } from '../../../theme';

const SLOTS: CapiSlot[] = ['hat', 'glasses', 'scarf'];

/** Perfil → Capi (MOT-03): show or hide the mascot and pick unlocked accessories. Nothing here is for sale. */
export default function CapiSettings() {
  const { refreshProfile } = useSession();
  const capi = useCapi();
  const overlay = useOverlay();

  const save = async (patch: { visible?: boolean; accessories?: string[] }) => {
    try {
      await updateSettings({ mascot: { visible: capi.visible, accessories: capi.requested, ...patch } });
      await refreshProfile();
    } catch {
      overlay.snack(t('error.generic'));
    }
  };

  const toggle = (id: string, slot: CapiSlot) => {
    const equipped = capi.accessories.some((a) => a.id === id);
    // One accessory per slot: equipping replaces whatever the slot had.
    const others = capi.accessories.filter((a) => a.slot !== slot).map((a) => a.id);
    void save({ accessories: equipped ? others : [...others, id] });
  };

  const unlockHint = (unlock: { level: number } | { achievement: string }) => {
    if ('level' in unlock) return t('capi.unlock_level', { n: unlock.level });
    const name = ACHIEVEMENTS.find((a) => a.code === unlock.achievement)?.name ?? unlock.achievement;
    return t('capi.unlock_achievement', { name });
  };

  return (
    <Screen title={t('capi.title')}>
      <Card tone="soft">
        <View style={{ alignItems: 'center', gap: space.sm }}>
          <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={160} />
          <Text variant="heading" align="center">
            {t('capi.stage_title', { stage: t(`capi.stage.${capi.stage}`) })}
          </Text>
          <Text variant="bodySmall" tone="secondary" align="center">
            {t('capi.intro')}
          </Text>
        </View>
      </Card>
      <SwitchRow label={t('capi.visible')} hint={t('capi.visible_hint')} value={capi.visible} onChange={(v) => void save({ visible: v })} />
      {SLOTS.map((slot) => (
        <Section key={slot} title={t(`capi.slot.${slot}`)}>
          <ChipGroup>
            {capi.catalog
              .filter((a) => a.slot === slot)
              .map((a) => (
                <Chip
                  key={a.id}
                  label={a.name}
                  icon={a.unlocked ? undefined : 'lock-closed-outline'}
                  selected={a.equipped}
                  disabled={!a.unlocked}
                  accessibilityLabel={a.unlocked ? a.name : `${a.name}. ${unlockHint(a.unlock)}`}
                  onPress={() => toggle(a.id, slot)}
                />
              ))}
          </ChipGroup>
          {capi.catalog
            .filter((a) => a.slot === slot && !a.unlocked)
            .slice(0, 1)
            .map((a) => (
              <Text key={a.id} variant="caption" tone="secondary">
                {`${a.name}: ${unlockHint(a.unlock)}`}
              </Text>
            ))}
        </Section>
      ))}
    </Screen>
  );
}
